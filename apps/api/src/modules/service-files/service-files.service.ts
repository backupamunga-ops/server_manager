import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile, rm, stat, lstat } from 'node:fs/promises';
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
