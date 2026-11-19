import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';

const MAX_EXTRACTED_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_ENTRIES = 100000;
const BLOCK = 512;

export interface TarEntry {
  name: string;
  size: number;
  type: 'file' | 'dir' | 'other';
}

/**
 * Parse a POSIX/GNU tar archive buffer into entries (names + sizes).
 * Used for GitHub codeload archives (tar.gz). Rejects path traversal
 * and reports symlinks/hardlinks as 'other' so callers can skip them.
 */
export function listTarEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    // End-of-archive: two consecutive zero blocks
    if (header.every((b) => b === 0)) break;

    let name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0+$/, '');
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      // GNU long name entry: the name is stored in the following data block
      longName = buf
        .subarray(dataStart, dataStart + size)
        .toString('utf8')
        .replace(/\0+$/, '');
      offset = dataEnd;
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }

    if (
      name.includes('../') ||
      name.includes('..\\') ||
      name.startsWith('/') ||
      /^[a-zA-Z]:[/\\]/.test(name)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Archive contains path traversal in entry: ${name}`,
      });
    }

    let type: TarEntry['type'] = 'other';
    if (typeflag === '0' || typeflag === '\0') type = 'file';
    else if (typeflag === '5') type = 'dir';
    // '1' hardlink, '2' symlink, '3'/'4' devices, etc. stay 'other' (skipped)

    entries.push({ name, size, type });
    offset = dataEnd;
    if (entries.length > MAX_ENTRIES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Archive has too many entries.',
      });
    }
  }
  return entries;
}

/**
 * Safely extract a tar.gz (or tar) buffer to destDir.
 * Strips the leading archive folder (codeload style: {repo}-{branch}/...)
 * when stripFirstSegment is set. Symlinks and special entries are skipped.
 */
export async function extractTarGzSafe(
  buf: Buffer,
  destDir: string,
  opts: { stripFirstSegment?: boolean; isGzip?: boolean } = {},
): Promise<number> {
  const raw = opts.isGzip === false ? buf : gunzipSync(buf);
  const absDest = resolve(destDir) + sep;
  let written = 0;
  let count = 0;
  let offset = 0;
  let longName: string | null = null;

  await mkdir(absDest, { recursive: true });

  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;

    let name = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0+$/, '');
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      longName = raw
        .subarray(dataStart, dataStart + size)
        .toString('utf8')
        .replace(/\0+$/, '');
      offset = dataEnd;
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }

    offset = dataEnd;

    if (
      name.includes('../') ||
      name.includes('..\\') ||
      name.startsWith('/') ||
      /^[a-zA-Z]:[/\\]/.test(name)
    ) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Archive contains path traversal in entry: ${name}`,
      });
    }

    let rel = name;
    if (opts.stripFirstSegment) {
      const idx = rel.indexOf('/');
      if (idx > 0) rel = rel.slice(idx + 1);
      else continue; // the top-level folder itself
    }
    if (!rel) continue;

    const target = resolve(join(absDest, rel));
    if (!target.startsWith(absDest)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Archive entry escapes destination: ${name}`,
      });
    }

    if (typeflag === '5') {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0') continue; // skip links/devices

    await mkdir(dirname(target), { recursive: true });
    const content = raw.subarray(dataStart, dataStart + size);
    written += size;
    count += 1;
    if (written > MAX_EXTRACTED_SIZE) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Archive extraction exceeded the size limit.',
      });
    }
    await writeFile(target, content, { mode: 0o644 });
  }
  return count;
}
