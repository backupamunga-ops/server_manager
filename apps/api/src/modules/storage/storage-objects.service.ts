import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export interface StorageListingFolder {
  name: string;
  key: string;
}

export interface StorageListingFile {
  key: string;
  name: string;
  size: number;
  lastModified: string | null;
}

export interface StorageListing {
  bucket: string;
  endpoint: string;
  prefix: string;
  folders: StorageListingFolder[];
  files: StorageListingFile[];
}

/**
 * Real S3 object operations against Garage on this VPS. Credentials come from
 * S3_ACCESS_KEY / S3_SECRET_KEY (the `cloudlane-objects` Garage key), which is
 * granted read/write on every workspace bucket by the storage pipeline.
 */
@Injectable()
export class StorageObjectsService {
  private readonly logger = new Logger('StorageObjects');
  private readonly client: S3Client;

  constructor(private readonly config: ConfigService) {
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: this.config.get<string>('S3_REGION') ?? 'garage',
      credentials: {
        accessKeyId: this.config.get<string>('S3_ACCESS_KEY') ?? '',
        secretAccessKey: this.config.get<string>('S3_SECRET_KEY') ?? '',
      },
      forcePathStyle: true,
    });
  }

  get endpoint(): string {
    return this.config.get<string>('S3_ENDPOINT') ?? 'http://127.0.0.1:3900';
  }

  get configured(): boolean {
    return Boolean(this.config.get<string>('S3_ACCESS_KEY') && this.config.get<string>('S3_SECRET_KEY'));
  }

  /** One-level listing: folders (CommonPrefixes) + files under `prefix`. */
  async list(bucket: string, prefix: string): Promise<StorageListing> {
    const res = await this.client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: 1000,
    }));
    const folders = (res.CommonPrefixes ?? [])
      .map((p) => {
        const key = p.Prefix ?? '';
        return { key, name: key.slice(prefix.length).replace(/\/$/, '') };
      })
      .filter((f) => f.name.length > 0);
    const files = (res.Contents ?? [])
      .map((o) => {
        const key = o.Key ?? '';
        return {
          key,
          name: key.slice(prefix.length),
          size: o.Size ?? 0,
          lastModified: o.LastModified ? o.LastModified.toISOString() : null,
        };
      })
      .filter((f) => f.name.length > 0 && !f.key.endsWith('/'));
    return { bucket, endpoint: this.endpoint, prefix, folders, files };
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(bucket: string, key: string): Promise<{ body: NonNullable<ReturnType<typeof streamOf>>; type: string; length: number }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return {
      body: streamOf(res.Body),
      type: res.ContentType ?? 'application/octet-stream',
      length: res.ContentLength ?? 0,
    };
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /** Delete a prefix and everything under it. Returns the object count removed. */
  async removeFolder(bucket: string, prefix: string): Promise<number> {
    let removed = 0;
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }));
      for (const o of res.Contents ?? []) {
        if (o.Key) {
          await this.remove(bucket, o.Key);
          removed++;
        }
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return removed;
  }
}

function streamOf(body: unknown): { pipe: (dest: unknown) => void } & ReadableStream {
  return body as never;
}
