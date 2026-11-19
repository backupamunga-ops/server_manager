import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';

const MAX_ENTRIES = 100000;
const MAX_EXTRACTED_SIZE = 100 * 1024 * 1024; // 100 MB
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface ZipInfo {
  entryCount: number;
  entries: ZipEntry[];
  totalUncompressed: number;
  totalCompressed: number;
}

/**
 * Parse the central directory of a ZIP file.
 * Shared by upload validation and deployment extraction so both enforce
 * the same safety rules (build plan §11.1).
 */
export async function readZipInfo(filePath: string): Promise<ZipInfo> {
  const data = await readFile(filePath);
  if (data.length < 22) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'File too small to be a valid ZIP.',
    });
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
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
  if (entryCount > MAX_ENTRIES) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: `ZIP has too many entries (${entryCount}). Maximum ${MAX_ENTRIES}.`,
    });
  }

  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CD_SIG) {
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
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const externalAttrs = view.getUint32(offset + 38, true);

    if (offset + 46 + nameLen > view.byteLength) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'ZIP entry name is corrupted.',
      });
    }
    const name = Buffer.from(data.subarray(offset + 46, offset + 46 + nameLen)).toString('utf8');

    if (
      name.includes('../') ||
      name.includes('..\\') ||
      /^[a-zA-Z]:[/\\]/.test(name) ||
      name.startsWith('/')
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `ZIP contains path traversal in entry: ${name}`,
      });
    }

    // unix mode lives in the high 16 bits of external attrs (when created on unix)
    const mode = (externalAttrs >>> 16) & 0xffff;
    const isDirectory = name.endsWith('/') || (mode & 0o170000) === 0o040000;
    const isSymlink = (mode & 0o170000) === 0o120000;

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      method: 0,
      localHeaderOffset,
      isDirectory,
      isSymlink,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const totalUncompressed = entries.reduce((s, e) => s + e.uncompressedSize, 0);
  const totalCompressed = entries.reduce((s, e) => s + e.compressedSize, 0);

  if (totalUncompressed > MAX_EXTRACTED_SIZE) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: `ZIP contents too large when extracted (${totalUncompressed} bytes). Maximum ${MAX_EXTRACTED_SIZE} bytes.`,
    });
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > 100) {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'ZIP compression ratio too high (possible zip bomb).',
    });
  }

  return { entryCount, entries, totalUncompressed, totalCompressed };
}

/** Detect the framework from ZIP entry names (build plan §11.1 step 2). */
export function detectFramework(names: string[]): string {
  const has = (needle: string) => names.some((n) => n.toLowerCase().endsWith(needle));
  if (has('nest-cli.json')) return 'NestJS';
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) return 'Next.js';
  if (has('vite.config.js') || has('vite.config.ts')) return 'React/Vite';
  if (has('dockerfile')) return 'Dockerfile';
  if (has('package.json')) return 'Node.js/Express';
  if (has('index.html')) return 'Static HTML';
  return 'Static HTML';
}

/**
 * Safely extract a ZIP archive to destDir.
 * Pure Node (zlib raw inflate) — no docker, no host shell-outs.
 * Defense in depth: path sanitisation and symlink rejection happen here even
 * though readZipInfo already rejects traversal entries.
 */
export async function extractZipSafe(zipPath: string, destDir: string): Promise<number> {
  const data = await readFile(zipPath);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const info = await readZipInfo(zipPath);
  const absDest = resolve(destDir) + sep;
  let written = 0;

  for (const entry of info.entries) {
    if (entry.isSymlink) continue; // never materialise symlinks
    const target = resolve(join(absDest, entry.name));
    if (!target.startsWith(absDest)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `ZIP entry escapes destination: ${entry.name}`,
      });
    }
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }

    // Locate and parse the local file header for the actual data offset.
    const lho = entry.localHeaderOffset;
    if (lho + 30 > view.byteLength || view.getUint32(lho, true) !== 0x04034b50) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'ZIP local header is corrupted.',
      });
    }
    const nameLen = view.getUint16(lho + 26, true);
    const extraLen = view.getUint16(lho + 28, true);
    const method = view.getUint16(lho + 8, true);
    const dataStart = lho + 30 + nameLen + extraLen;
    if (dataStart + entry.compressedSize > view.byteLength) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'ZIP entry data is corrupted.',
      });
    }

    await mkdir(dirname(target), { recursive: true });
    let content: Buffer;
    if (method === 0) {
      content = data.subarray(dataStart, dataStart + entry.compressedSize);
    } else if (method === 8) {
      content = inflateRawSync(data.subarray(dataStart, dataStart + entry.compressedSize));
    } else {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Unsupported ZIP compression method ${method} in entry ${entry.name}.`,
      });
    }
    if (content.length !== entry.uncompressedSize) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `ZIP entry size mismatch in ${entry.name}.`,
      });
    }
    written += content.length;
    if (written > MAX_EXTRACTED_SIZE) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'ZIP extraction exceeded the size limit.',
      });
    }
    await writeFile(target, content, { mode: 0o644 });
  }
  return info.entryCount;
}
