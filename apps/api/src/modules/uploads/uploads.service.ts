import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';

const MAX_ZIP_SIZE = 150 * 1024 * 1024; // 150 MB compressed
const MAX_EXTRACTED_SIZE = 300 * 1024 * 1024; // 300 MB extracted
/** Entries after excluding dependency/VCS/build-cache dirs. */
const MAX_ENTRIES = 30000;
const ABSOLUTE_MAX_ENTRIES = 65535; // hard cap (zip central directory is uint16)
/** Dependency/VCS/cache dirs that never count against limits. */
const IGNORED_PREFIXES = ['node_modules/', '.git/', '.next/', '.turbo/', '.cache/', '.pnpm-store/', 'dist-cache/'];
const UPLOAD_DIR = '/var/lib/cloudlane/uploads';
const SOURCES_DIR = '/var/lib/cloudlane/sources';

interface PendingUpload {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  sha256: string;
  stagedPath: string;
  entryCount: number;
  createdAt: Date;
}

const pendingUploads = new Map<string, PendingUpload>();

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Ensure upload directory exists
    mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});
  }

  /**
   * Initialize an upload. Returns an upload ID.
   * In production with Garage running, this would return a presigned S3 URL.
   * For now, the dashboard uploads directly to the API which stages the file.
   */
  async init(
    filename: string,
    size: number,
    mimeType: string,
  ): Promise<{ uploadId: string; uploadUrl: string; expiresAt: string }> {
    if (size > MAX_ZIP_SIZE) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `File too large. Maximum ${MAX_ZIP_SIZE / 1024 / 1024} MB. Tip: exclude node_modules — it is stripped automatically and never counts against limits.`,
      });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only .zip files are accepted.',
      });
    }

    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store metadata — the actual file is uploaded via PUT to the returned URL
    pendingUploads.set(uploadId, {
      id: uploadId,
      filename,
      size,
      mimeType,
      sha256: '',
      stagedPath: '',
      entryCount: 0,
      createdAt: new Date(),
    });

    // The upload URL is an internal endpoint that receives the file
    const uploadUrl = `/api/v1/uploads/${uploadId}/receive`;

    return {
      uploadId,
      uploadUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Receive the actual file data (called by the PUT to uploadUrl).
   */
  async receive(uploadId: string, data: Buffer, declaredSha256: string): Promise<void> {
    const pending = pendingUploads.get(uploadId);
    if (!pending) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Upload session not found or expired.',
      });
    }

    const actualSha256 = createHash('sha256').update(data).digest('hex');
    if (declaredSha256 && actualSha256 !== declaredSha256) {
      pendingUploads.delete(uploadId);
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'SHA256 mismatch. File may be corrupted.',
      });
    }

    const stagedPath = join(UPLOAD_DIR, `${uploadId}.zip`);
    await mkdir(UPLOAD_DIR, { recursive: true });
    await pipeline(async function* () {
      yield data;
    }, createWriteStream(stagedPath));

    pending.sha256 = actualSha256;
    pending.stagedPath = stagedPath;
    pending.size = data.length;

    this.logger.log(
      `Upload ${uploadId} received: ${data.length} bytes, sha256=${actualSha256.slice(0, 16)}...`,
    );
  }

  /**
   * Finalize an upload: validate the ZIP, detect framework, return result.
   */
  async finalize(
    uploadId: string,
    sha256: string,
  ): Promise<{ uploadId: string; validated: true; detectedFramework: string; entryCount: number }> {
    const pending = pendingUploads.get(uploadId);
    if (!pending || !pending.stagedPath) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Upload not found or not yet received.',
      });
    }

    // Verify SHA256
    if (sha256 && pending.sha256 !== sha256) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'SHA256 mismatch.',
      });
    }

    // Validate the ZIP file
    const validation = await this.validateZip(pending.stagedPath);
    this.logger.log(
      `Upload ${uploadId} validated: ${validation.entryCount} entries, framework=${validation.detectedFramework}`,
    );

    // Update pending upload with validation results
    pending.entryCount = validation.entryCount;

    return {
      uploadId,
      validated: true,
      detectedFramework: validation.detectedFramework,
      entryCount: validation.entryCount,
    };
  }

  /**
   * Get the staged file path for a validated upload.
   * Used by the deployment service to access the ZIP.
   */
  getStagedPath(uploadId: string): string {
    const pending = pendingUploads.get(uploadId);
    if (!pending || !pending.stagedPath) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Upload not found.' });
    }
    return pending.stagedPath;
  }

  /**
   * Clean up a staged upload after deployment is created.
   */
  cleanup(uploadId: string): void {
    const pending = pendingUploads.get(uploadId);
    if (pending?.stagedPath) {
      unlink(pending.stagedPath).catch(() => {});
    }
    pendingUploads.delete(uploadId);
  }

  /**
   * Move a validated upload from staging to the permanent sources directory
   * and return its recorded metadata. Called when a service is created so the
   * deployment pipeline (and future redeploys) can always read the source.
   */
  async persist(uploadId: string): Promise<{ path: string; sha256: string; size: number }> {
    const pending = pendingUploads.get(uploadId);
    if (!pending || !pending.stagedPath) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Upload not found or not yet received.',
      });
    }
    await mkdir(SOURCES_DIR, { recursive: true });
    const finalPath = join(SOURCES_DIR, `${uploadId}.zip`);
    if (pending.stagedPath !== finalPath) {
      const { rename } = await import('node:fs/promises');
      await rename(pending.stagedPath, finalPath);
      pending.stagedPath = finalPath;
    }
    return { path: finalPath, sha256: pending.sha256, size: pending.size };
  }

  getSha256(uploadId: string): string {
    return pendingUploads.get(uploadId)?.sha256 ?? '';
  }

  getFileSize(uploadId: string): number {
    return pendingUploads.get(uploadId)?.size ?? 0;
  }

  /**
   * Validate a ZIP file for security:
   * - No path traversal (../, absolute paths)
   * - No symlink escapes
   * - No zip bombs (compression ratio check)
   * - Entry count limit
   * - Framework detection
   */
  private async validateZip(
    filePath: string,
  ): Promise<{ entryCount: number; detectedFramework: string }> {
    const data = await readFile(filePath);
    const stats = await stat(filePath);

    // Parse ZIP central directory
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.byteLength < 22) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'File too small to be a valid ZIP.',
      });
    }

    // Find End of Central Directory record
    let eocd = -1;
    for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Invalid ZIP: no end of central directory.',
      });
    }

    const entryCount = view.getUint16(eocd + 10, true);
    if (entryCount > ABSOLUTE_MAX_ENTRIES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `ZIP has too many entries (${entryCount}). Maximum ${ABSOLUTE_MAX_ENTRIES}.`,
      });
    }

    const cdOffset = view.getUint32(eocd + 16, true);
    let offset = cdOffset;
    const entries: { name: string; compressedSize: number; uncompressedSize: number }[] = [];

    for (let i = 0; i < entryCount; i++) {
      if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'ZIP central directory is corrupted.',
        });
      }
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);

      if (offset + 46 + nameLen > view.byteLength) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'ZIP entry name is corrupted.',
        });
      }

      const name = Buffer.from(data.subarray(offset + 46, offset + 46 + nameLen)).toString('utf8');

      // Security checks
      if (name.includes('../') || name.startsWith('/') || name.includes('\\..\\')) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `ZIP contains path traversal in entry: ${name}`,
        });
      }

      entries.push({ name, compressedSize, uncompressedSize });
      offset += 46 + nameLen + extraLen + commentLen;
    }

    // Dependency/cache entries are stripped at extraction; they never count
    // against entry or size limits.
    const isIgnored = (name: string) =>
      IGNORED_PREFIXES.some((pre) => name.toLowerCase().startsWith(pre) || name.toLowerCase().includes('/' + pre));
    const deployable = entries.filter((e) => !isIgnored(e.name));
    if (deployable.length > MAX_ENTRIES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `ZIP has too many entries (${deployable.length} after excluding node_modules/.git). Maximum ${MAX_ENTRIES}.`,
      });
    }

    // Check for zip bomb: total uncompressed size (deployable content only)
    const totalUncompressed = deployable.reduce((sum, e) => sum + e.uncompressedSize, 0);
    if (totalUncompressed > MAX_EXTRACTED_SIZE) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `ZIP contents too large when extracted (${Math.round(totalUncompressed / 1024 / 1024)} MB). Maximum ${MAX_EXTRACTED_SIZE / 1024 / 1024} MB (excluding node_modules).`,
      });
    }

    // Check compression ratio (zip bomb indicator)
    const totalCompressed = deployable.reduce((sum, e) => sum + e.compressedSize, 0);
    if (totalCompressed > 0 && totalUncompressed / totalCompressed > 100) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'ZIP compression ratio too high (possible zip bomb).',
      });
    }

    // Detect framework from entry names
    const names = entries.map((e) => e.name.toLowerCase());
    const detectedFramework = this.detectFramework(names);

    return { entryCount, detectedFramework };
  }

  private detectFramework(names: string[]): string {
    const has = (needle: string) => names.some((n) => n.endsWith(needle));
    if (has('go.mod')) return 'Go';
    if (has('requirements.txt') || has('pyproject.toml') || has('manage.py')) return 'Python';
    if (has('composer.json')) return 'PHP';
    if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'Java';
    if (names.some((n) => n.endsWith('.csproj')) || names.some((n) => n.endsWith('.sln'))) return 'C#';
    if (has('cargo.toml')) return 'Rust';
    if (has('gemfile')) return 'Ruby';
    if (has('nest-cli.json')) return 'NestJS';
    if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) return 'Next.js';
    if (has('nuxt.config.ts') || has('nuxt.config.js')) return 'Nuxt';
    if (has('svelte.config.js') || has('svelte.config.mjs')) return 'SvelteKit';
    if (has('angular.json')) return 'Angular';
    if (has('astro.config.mjs') || has('astro.config.js')) return 'Astro';
    if (has('vite.config.js') || has('vite.config.ts')) return 'React/Vite';
    if (has('dockerfile')) return 'Dockerfile';
    if (has('package.json')) return 'Node.js';
    if (has('index.html')) return 'Static HTML';
    return 'Static HTML'; // default for ZIP uploads
  }

  getEntryCount(uploadId: string): number {
    const pending = pendingUploads.get(uploadId);
    return pending?.entryCount ?? 0;
  }
}
