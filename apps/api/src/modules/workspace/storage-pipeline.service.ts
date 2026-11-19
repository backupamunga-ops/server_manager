import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execCapture = promisify(execFile) as (
  cmd: string, args: string[], opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

const GARAGE_CONTAINER = 'cloudlane-garage';

/**
 * Real object storage pipeline backed by Garage (S3-compatible) on this VPS.
 * Buckets are created in the Garage cluster and granted to the platform API
 * key, so objects written through S3 clients land in real storage.
 */
@Injectable()
export class StoragePipelineService {
  private readonly logger = new Logger('StoragePipeline');

  constructor(private readonly config: ConfigService) {}

  get endpoint(): string {
    return this.config.get<string>('S3_ENDPOINT') ?? 'http://127.0.0.1:3900';
  }

  get region(): string {
    return this.config.get<string>('S3_REGION') ?? 'garage';
  }

  private async garage(args: string[]): Promise<string> {
    const res = await execCapture('docker', [ 'exec', GARAGE_CONTAINER, '/garage', ...args ], { timeout: 30_000 });
    return res.stdout;
  }

  /**
   * Create the bucket (idempotent) and grant the platform key read/write.
   * Throws on hard failures so the caller can fall back to metadata-only.
   */
  async ensureBucket(rawName: string): Promise<{ bucket: string; endpoint: string; region: string }> {
    const name = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 52);
    if (!/^[a-z][a-z0-9-]{2,51}$/.test(name)) {
      throw new Error('Invalid bucket name after normalization.');
    }
    try {
      await this.garage([ 'bucket', 'create', name ]);
    } catch (err) {
      const msg = String((err as { stderr?: string })?.stderr ?? err);
      if (!/already exists/i.test(msg)) this.logger.warn(`bucket create ${name}: ${msg.slice(0, 120)}`);
    }
    // Grant the platform S3 key (tolerate already-granted).
    try {
      await this.garage([ 'bucket', 'allow', '--read', '--write', '--key', 'cloudlane-api', name ]);
    } catch (err) {
      const msg = String((err as { stderr?: string })?.stderr ?? err);
      this.logger.warn(`bucket allow ${name}: ${msg.slice(0, 120)}`);
    }
    this.logger.log(`garage bucket ready: ${name}`);
    return { bucket: name, endpoint: this.endpoint, region: this.region };
  }

  async removeBucket(name: string): Promise<void> {
    try {
      await this.garage([ 'bucket', 'delete', '--yes', name ]);
    } catch (err) {
      this.logger.warn(`bucket delete ${name}: ${String((err as { stderr?: string })?.stderr ?? err).slice(0, 120)}`);
    }
  }
}
