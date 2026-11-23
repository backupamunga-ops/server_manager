import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { cp as fsCp, mkdir, readdir, readFile, rename as fsRename, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { PrismaService } from '../../common/prisma.service.js';
import { extractZipSafe } from '../../common/zip.js';
import { AuditService } from '../audit/audit.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { DeploymentsService } from '../deployments/deployments.service.js';

const DEPLOYMENTS_DIR = '/var/lib/cloudlane/deployments';
const MAX_READ_BYTES = 512 * 1024; // 512 KB per file read
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MB per file write (text editor)
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB per raw file upload
const MAX_COPY_BYTES = 200 * 1024 * 1024; // 200 MB total per copy operation
const MAX_COPY_FILES = 5_000; // per copy operation
const MAX_COPY_DEPTH = 12;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_SCANNED = 20_000; // entries walked per search

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modified: string;
}

@Injectable()
export class ServiceFilesService {
  private readonly logger = new Logger(ServiceFilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly uploads: UploadsService,
    private readonly deployments: DeploymentsService,
  ) {}

  /** Resolve the service for an owner, enforcing kind + a live deployment. */
  private async activeRoot(userId: string, serviceId: string): Promise<{
    serviceId: string;
    serviceName: string;
    workspaceId: string;
    deploymentId: string;
    root: string;
  }> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { include: { workspace: true } } },
    });
    if (!service || service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }
    if (service.kind !== 'application') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'File management is only available for application services.',
      });
    }
    if (service.observedState === 'deploying') {
      throw new BadRequestException({
        code: 'CONFLICT',
        message: 'A deployment is in progress — wait for it to finish before editing files.',
      });
    }
    const deploymentId = service.activeDeploymentId;
    if (!deploymentId) {
      throw new BadRequestException({
        code: 'CONFLICT',
        message: 'No live deployment yet — deploy the service first, then manage its files.',
      });
    }
    return {
      serviceId: service.id,
      serviceName: service.name,
      workspaceId: service.project.workspaceId,
      deploymentId,
      root: join(DEPLOYMENTS_DIR, deploymentId, 'html'),
    };
  }

  /** Jail a user-relative path inside the deployment root. */
  private resolveIn(root: string, rel: string): string {
    const clean = String(rel ?? '').replace(/^\/+/, '').replace(/\\+/g, '/');
    if (clean.split('/').includes('..')) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Path escapes the deployment directory.',
      });
    }
    const target = resolve(root, clean);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Path escapes the deployment directory.',
      });
    }
    return target;
  }

  async list(
    userId: string,
    serviceId: string,
    relPath: string,
  ): Promise<{ path: string; items: FileEntry[] }> {
    const { root } = await this.activeRoot(userId, serviceId);
    const dir = this.resolveIn(root, relPath);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Directory not found.' });
    }
    const items: FileEntry[] = [];
    for (const e of entries) {
      if (e.name === '.well-known' && relPath === '') continue;
      const full = join(dir, e.name);
      let size = 0;
      let modified = new Date(0);
      try {
        const st = await stat(full);
        size = st.size;
        modified = st.mtime;
      } catch { /* broken symlink etc. — still listed */ }
      items.push({
        name: e.name,
        path: relPath ? `${relPath.replace(/\/$/, '')}/${e.name}` : e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size,
        modified: modified.toISOString(),
      });
    }
    items.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    );
    return { path: relPath ?? '', items };
  }

  /** Raw file bytes for download (any file type, up to 100 MB). */
  async readRaw(
    userId: string,
    serviceId: string,
    relPath: string,
  ): Promise<{ data: Buffer; size: number }> {
    const { root } = await this.activeRoot(userId, serviceId);
    if (!relPath) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File path is required.' });
    }
    const target = this.resolveIn(root, relPath);
    const st = await stat(target).catch(() => {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'File not found.' });
    });
    if (!st.isFile()) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Not a regular file.' });
    }
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `File too large to download (${Math.round(st.size / 1024 / 1024)} MB). Maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      });
    }
    return { data: await readFile(target), size: st.size };
  }

  async readContent(
    userId: string,
    serviceId: string,
    relPath: string,
  ): Promise<{ path: string; size: number; modified: string; content: string }> {
    const { root } = await this.activeRoot(userId, serviceId);
    if (!relPath) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File path is required.' });
    }
    const target = this.resolveIn(root, relPath);
    const st = await stat(target).catch(() => {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'File not found.' });
    });
    if (!st.isFile()) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Not a regular file.' });
    }
    if (st.size > MAX_READ_BYTES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `File is too large to edit in the browser (${Math.round(st.size / 1024)} KB). Maximum ${MAX_READ_BYTES / 1024} KB.`,
      });
    }
    const buf = await readFile(target);
    if (buf.includes(0)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Binary file — cannot be edited as text.',
      });
    }
    return {
      path: relPath,
      size: st.size,
      modified: st.mtime.toISOString(),
      content: buf.toString('utf8'),
    };
  }

  async writeContent(
    userId: string,
    serviceId: string,
    relPath: string,
    content: string,
  ): Promise<{ path: string; size: number }> {
    const { root, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    if (!relPath) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File path is required.' });
    }
    const body = Buffer.from(String(content ?? ''), 'utf8');
    if (body.length > MAX_WRITE_BYTES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `File too large to save (${Math.round(body.length / 1024)} KB). Maximum ${MAX_WRITE_BYTES / 1024} KB.`,
      });
    }
    const target = this.resolveIn(root, relPath);
    const existing = await lstat(target).catch(() => null);
    if (existing && existing.isSymbolicLink()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Refusing to overwrite a symlink.',
      });
    }
    if (existing && existing.isDirectory()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Target path is a directory.',
      });
    }
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, body, { mode: 0o644 });
    await this.audit.record('SERVICE_FILE_UPDATED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, path: relPath, bytes: body.length, via: 'file-editor' },
    });
    return { path: relPath, size: body.length };
  }

  async mkdirp(userId: string, serviceId: string, relPath: string): Promise<{ path: string }> {
    const { root } = await this.activeRoot(userId, serviceId);
    if (!relPath) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Directory path is required.' });
    }
    const target = this.resolveIn(root, relPath);
    const existing = await lstat(target).catch(() => null);
    if (existing && !existing.isDirectory()) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'A file already exists at that path.',
      });
    }
    await mkdir(target, { recursive: true });
    return { path: relPath };
  }

  async remove(userId: string, serviceId: string, relPath: string): Promise<{ removed: string }> {
    const { root, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    if (!relPath) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Refusing to delete the deployment root.',
      });
    }
    const target = this.resolveIn(root, relPath);
    const existing = await lstat(target).catch(() => null);
    if (!existing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'File not found.' });
    }
    if (existing.isSymbolicLink()) {
      await rm(target, { force: true });
    } else {
      await rm(target, { recursive: true, force: false });
    }
    await this.audit.record('SERVICE_FILE_DELETED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, path: relPath, via: 'file-manager' },
    });
    return { removed: relPath };
  }

  /** Rename (or move, when `to` contains a directory segment) within the deployment. */
  async rename(userId: string, serviceId: string, from: string, to: string): Promise<{ from: string; to: string }> {
    const { root, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    if (!from || !to) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Both source and target paths are required.' });
    }
    if (from === to) return { from, to };
    const src = this.resolveIn(root, from);
    const dst = this.resolveIn(root, to);
    const existing = await lstat(src).catch(() => null);
    if (!existing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'File not found.' });
    }
    if (existing.isSymbolicLink()) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Refusing to rename a symlink.' });
    }
    const clash = await lstat(dst).catch(() => null);
    if (clash) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Target already exists — choose another name.' });
    }
    await mkdir(resolve(dst, '..'), { recursive: true });
    await fsRename(src, dst);
    await this.audit.record('SERVICE_FILE_RENAMED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, from, to, via: 'file-manager' },
    });
    return { from, to };
  }

  /** Copy a file or folder inside the deployment (never follows symlinks). */
  async copy(userId: string, serviceId: string, from: string, to: string): Promise<{ from: string; to: string }> {
    const { root, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    if (!from || !to) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Both source and target paths are required.' });
    }
    const src = this.resolveIn(root, from);
    const dst = this.resolveIn(root, to);
    if (dst.startsWith(src + sep)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Cannot copy a folder into itself.' });
    }
    const existing = await lstat(src).catch(() => null);
    if (!existing) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'File not found.' });
    }
    if (existing.isSymbolicLink()) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Refusing to copy a symlink.' });
    }
    const clash = await lstat(dst).catch(() => null);
    if (clash) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Target already exists — choose another name.' });
    }
    if (existing.isFile()) {
      if (existing.size > MAX_UPLOAD_BYTES) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `File too large to copy (${Math.round(existing.size / 1024 / 1024)} MB). Maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
        });
      }
      await mkdir(resolve(dst, '..'), { recursive: true });
      await fsCp(src, dst, { errorOnExist: true, force: false });
    } else if (existing.isDirectory()) {
      const stats = await this.walkCaps(src);
      await mkdir(resolve(dst, '..'), { recursive: true });
      await fsCp(src, dst, { recursive: true, errorOnExist: true, force: false });
      await this.audit.record('SERVICE_FILE_COPIED', 'success', {
        actorType: 'user',
        actorUserId: userId,
        workspaceId,
        resourceType: 'service',
        resourceId: sid,
        metadata: { service: serviceName, from, to, files: stats.files, bytes: stats.bytes, via: 'file-manager' },
      });
      return { from, to };
    } else {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Unsupported file type.' });
    }
    await this.audit.record('SERVICE_FILE_COPIED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, from, to, via: 'file-manager' },
    });
    return { from, to };
  }

  /** Pre-flight size/count caps for a recursive folder copy. */
  private async walkCaps(dir: string, depth = 0): Promise<{ files: number; bytes: number }> {
    if (depth > MAX_COPY_DEPTH) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Folder is nested too deeply to copy (max ${MAX_COPY_DEPTH} levels).`,
      });
    }
    let files = 0;
    let bytes = 0;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { files, bytes };
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow or duplicate links
      if (e.isDirectory()) {
        const sub = await this.walkCaps(full, depth + 1);
        files += sub.files;
        bytes += sub.bytes;
      } else {
        files += 1;
        const st = await stat(full).catch(() => null);
        bytes += st?.size ?? 0;
      }
      if (files > MAX_COPY_FILES) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Folder too large to copy (max ${MAX_COPY_FILES.toLocaleString()} files).`,
        });
      }
      if (bytes > MAX_COPY_BYTES) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Folder too large to copy (max ${MAX_COPY_BYTES / 1024 / 1024} MB).`,
        });
      }
    }
    return { files, bytes };
  }

  /**
   * Recursive name search across the whole deployment (case-insensitive
   * substring). Skips symlinks; capped so huge trees (node_modules) cannot
   * stall the request.
   */
  async search(userId: string, serviceId: string, q: string): Promise<{ query: string; items: FileEntry[]; truncated: boolean }> {
    const { root } = await this.activeRoot(userId, serviceId);
    const needle = String(q ?? '').trim().toLowerCase();
    if (!needle) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Search term is required.' });
    }
    const items: FileEntry[] = [];
    let truncated = false;
    let scanned = 0;
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (truncated || scanned >= MAX_SEARCH_SCANNED || depth > MAX_COPY_DEPTH) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (truncated || scanned >= MAX_SEARCH_SCANNED) {
          truncated = truncated || scanned >= MAX_SEARCH_SCANNED;
          return;
        }
        scanned += 1;
        if (e.isSymbolicLink()) continue;
        if (e.name === '.well-known' && rel === '') continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const isDir = e.isDirectory();
        if (e.name.toLowerCase().includes(needle)) {
          const full = join(dir, e.name);
          let size = 0;
          let modified = new Date(0);
          try {
            const st = await stat(full);
            size = st.size;
            modified = st.mtime;
          } catch { /* raced — list it anyway */ }
          items.push({ name: e.name, path: childRel, type: isDir ? 'dir' : 'file', size, modified: modified.toISOString() });
          if (items.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            return;
          }
        }
        if (isDir) await walk(join(dir, e.name), childRel, depth + 1);
      }
    };
    await walk(root, '', 0);
    return { query: needle, items, truncated };
  }

  /**
   * Deployment usage snapshot for the file-manager sidebar: total size,
   * file/dir counts and the most recently modified files. Same caps and
   * symlink rules as search — huge trees cannot stall the request.
   */
  async usage(userId: string, serviceId: string): Promise<{ bytes: number; files: number; dirs: number; recent: FileEntry[] }> {
    const { root } = await this.activeRoot(userId, serviceId);
    let bytes = 0;
    let files = 0;
    let dirs = 0;
    const all: FileEntry[] = [];
    let scanned = 0;
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (scanned >= MAX_SEARCH_SCANNED || depth > MAX_COPY_DEPTH) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (scanned >= MAX_SEARCH_SCANNED) return;
        scanned += 1;
        if (e.isSymbolicLink()) continue;
        if (e.name === '.well-known' && rel === '') continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          dirs += 1;
          await walk(join(dir, e.name), childRel, depth + 1);
          continue;
        }
        const full = join(dir, e.name);
        let size = 0;
        let modified = new Date(0);
        try {
          const st = await stat(full);
          size = st.size;
          modified = st.mtime;
        } catch { /* raced — count it with zeros */ }
        files += 1;
        bytes += size;
        all.push({ name: e.name, path: childRel, type: 'file', size, modified: modified.toISOString() });
      }
    };
    await walk(root, '', 0);
    all.sort((a, b) => b.modified.localeCompare(a.modified));
    return { bytes, files, dirs, recent: all.slice(0, 10) };
  }

  /** Binary-safe single-file upload into the live deployment (raw body). */
  async uploadFile(
    userId: string,
    serviceId: string,
    relPath: string,
    data: Buffer,
  ): Promise<{ path: string; size: number }> {
    const { root, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    if (!relPath) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File path is required.' });
    }
    if (data.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `File too large (${Math.round(data.length / 1024 / 1024)} MB). Maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      });
    }
    const target = this.resolveIn(root, relPath);
    const existing = await lstat(target).catch(() => null);
    if (existing && (existing.isDirectory() || existing.isSymbolicLink())) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: existing.isDirectory()
          ? 'Target path is a directory.'
          : 'Refusing to overwrite a symlink.',
      });
    }
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, data, { mode: 0o644 });
    await this.audit.record('SERVICE_FILE_UPLOADED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, path: relPath, bytes: data.length, via: 'file-upload' },
    });
    return { path: relPath, size: data.length };
  }

  /**
   * Extract a validated uploaded ZIP into the live deployment directory
   * (hotfix path). Does NOT touch the stored source — a later Redeploy would
   * overwrite these files. Use redeployZip to make a ZIP the new source.
   */
  async extract(
    userId: string,
    serviceId: string,
    uploadId: string,
    relPath: string,
  ): Promise<{ extractedInto: string; entryCount: number }> {
    const { root, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    const stagedPath = this.uploads.getStagedPath(uploadId);
    const targetDir = this.resolveIn(root, relPath);
    await mkdir(targetDir, { recursive: true });
    const entryCount = await extractZipSafe(stagedPath, targetDir);
    await this.audit.record('SERVICE_FILES_EXTRACTED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, into: relPath || '/', entries: entryCount, via: 'zip-extract' },
    });
    return { extractedInto: relPath || '/', entryCount };
  }

  /** Make an uploaded ZIP the service source and run a full redeploy. */
  async redeployZip(
    userId: string,
    serviceId: string,
    uploadId: string,
  ): Promise<{ serviceId: string; deploymentId: string }> {
    const { serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    const staged = await this.uploads.persist(uploadId);
    const entryCount = this.uploads.getEntryCount(uploadId);
    await this.prisma.zipSource.upsert({
      where: { serviceId: sid },
      create: {
        serviceId: sid,
        storagePath: staged.path,
        sha256: staged.sha256,
        fileSize: BigInt(staged.size),
        entryCount,
        detectedFramework: 'Uploaded archive',
      },
      update: {
        storagePath: staged.path,
        sha256: staged.sha256,
        fileSize: BigInt(staged.size),
        entryCount,
        detectedFramework: 'Uploaded archive',
      },
    });
    await this.audit.record('SERVICE_SOURCE_REPLACED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, bytes: staged.size, entries: entryCount, via: 'redeploy-zip' },
    });
    return await this.deployments.redeploy(userId, sid);
  }

  /** Restart the running container of the active deployment. */
  async restart(
    userId: string,
    serviceId: string,
  ): Promise<{ container: string; state: string }> {
    const { deploymentId, serviceId: sid, serviceName, workspaceId } = await this.activeRoot(userId, serviceId);
    const container = `cloudlane-svc-${deploymentId}`;
    const state = await new Promise<string>((resolvePromise) => {
      execFile('docker', ['restart', container], { timeout: 60_000 }, (err) => {
        if (err) {
          this.logger.warn(`Restart ${container} failed: ${err.message}`);
          resolvePromise('error');
          return;
        }
        execFile(
          'docker',
          ['inspect', '--format', '{{.State.Status}}', container],
          { timeout: 15_000 },
          (err2, stdout) => resolvePromise(err2 ? 'unknown' : String(stdout).trim() || 'unknown'),
        );
      });
    });
    if (state === 'error') {
      throw new BadRequestException({
        code: 'CONFLICT',
        message: 'Container restart failed — check the container logs on the server.',
      });
    }
    await this.audit.record('SERVICE_RESTARTED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: sid,
      metadata: { service: serviceName, container, via: 'files-tab' },
    });
    return { container, state };
  }
}
