import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Put,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { PrismaService } from '../../common/prisma.service.js';
import { StorageObjectsService } from './storage-objects.service.js';

/**
 * Real object endpoints for the workspace file manager. Every route resolves
 * the bucket through the caller's workspace before touching Garage, and every
 * mutation writes an activity row so the audit feed reflects real S3 changes.
 */
@ApiTags('storage')
@Controller('storage')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class StorageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: StorageObjectsService,
  ) {}

  private async ownBucket(userId: string, bucketId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { ownerId: userId } });
    if (!ws) throw new BadRequestException('Workspace not found.');
    const bucket = await this.prisma.bucket.findFirst({ where: { id: bucketId, workspaceId: ws.id } });
    if (!bucket) throw new BadRequestException('Bucket not found.');
    return { ws, bucket };
  }

  private safeName(raw: string): string {
    const last = String(raw ?? 'file').replace(/\\/g, '/').split('/').pop() ?? 'file';
    const clean = last.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90);
    return clean || 'file';
  }

  private safePrefix(raw: string): string {
    const value = String(raw ?? '');
    if (value.includes('..')) throw new BadRequestException('Invalid prefix.');
    const parts = value.split('/').filter(Boolean).map((p) => p.replace(/[^a-zA-Z0-9._-]/g, '_'));
    return parts.length ? `${parts.join('/')}/` : '';
  }

  private async log(wsId: string, title: string, detail: string): Promise<void> {
    await this.prisma.activityItem.create({
      data: { workspaceId: wsId, title, detail, type: 'system', createdAt: new Date() },
    });
  }

  @Get('usage')
  async usage(@CurrentUser() user: { userId: string }) {
    const ws = await this.prisma.workspace.findUnique({ where: { ownerId: user.userId } });
    if (!ws) throw new BadRequestException('Workspace not found.');
    const buckets = await this.prisma.bucket.findMany({ where: { workspaceId: ws.id } });
    const out = [];
    for (const b of buckets) {
      let files = 0;
      let bytes = 0;
      let live = false;
      try {
        const listing = await this.objects.list(b.name, '');
        files = listing.files.length;
        bytes = listing.files.reduce((n, f) => n + f.size, 0);
        live = true;
      } catch {
        // Bucket unreachable from Garage right now — report as not live.
      }
      out.push({ bucketId: b.id, name: b.name, files, bytes, maxMB: b.maxMB, privacy: b.privacy, live });
    }
    return { endpoint: this.objects.endpoint, buckets: out };
  }

  @Get('buckets/:bucketId/objects')
  async list(
    @CurrentUser() user: { userId: string },
    @Param('bucketId') bucketId: string,
    @Query('prefix') prefixRaw = '',
    @Query('deep') deepRaw = '',
  ) {
    const { bucket } = await this.ownBucket(user.userId, bucketId);
    const prefix = this.safePrefix(prefixRaw);
    const listing = await this.objects.list(bucket.name, prefix);
    if (deepRaw === '1') {
      // Full subtree walk for the standalone file manager's tree (capped).
      const nodes: Array<{ key: string; name: string; type: 'folder' | 'file'; size: number; lastModified: string | null }> = [];
      const queue: Array<{ prefix: string; depth: number }> = [{ prefix, depth: 0 }];
      let walks = 0;
      while (queue.length && nodes.length < 1200 && walks < 160) {
        const step = queue.shift()!;
        walks++;
        const lvl = await this.objects.list(bucket.name, step.prefix);
        for (const f of lvl.folders) {
          if (nodes.length >= 1200) break;
          nodes.push({ key: f.key, name: f.name, type: 'folder', size: 0, lastModified: null });
          if (step.depth < 5) queue.push({ prefix: f.key, depth: step.depth + 1 });
        }
        for (const f of lvl.files) {
          if (nodes.length >= 1200) break;
          nodes.push({ key: f.key, name: f.name, type: 'file', size: f.size, lastModified: f.lastModified });
        }
      }
      return { ...listing, bucketId: bucket.id, privacy: bucket.privacy, maxMB: bucket.maxMB, purpose: bucket.purpose, deep: nodes };
    }
    return {
      ...listing,
      bucketId: bucket.id,
      privacy: bucket.privacy,
      maxMB: bucket.maxMB,
      purpose: bucket.purpose,
    };
  }

  @Post('buckets/:bucketId/transfer')
  async transfer(
    @CurrentUser() user: { userId: string },
    @Param('bucketId') bucketId: string,
    @Body() body: { mode?: string; sources?: string[]; dest?: string; renameTo?: string },
  ) {
    const { ws, bucket } = await this.ownBucket(user.userId, bucketId);
    const mode = body?.mode === 'move' ? 'move' : 'copy';
    const sources = Array.isArray(body?.sources) ? body.sources.slice(0, 12) : [];
    if (!sources.length) throw new BadRequestException('No source keys.');
    const destPrefix = this.safePrefix(body?.dest ?? '');
    let moved = 0;
    let skipped = 0;
    const changedRanges: Array<{ from: string; to: string }> = [];
    for (const raw of sources) {
      const src = String(raw ?? '');
      if (!src || src.includes('..')) { skipped++; continue; }
      const isFolder = src.endsWith('/');
      if (isFolder && destPrefix.startsWith(src)) { skipped++; continue; }
      const base = isFolder ? src.slice(0, -1).split('/').pop() ?? '' : src.split('/').pop() ?? '';
      const targetName = (body?.renameTo ?? '').trim() || base;
      if (!/^[a-zA-Z0-9._ -]{1,90}$/.test(targetName)) { skipped++; continue; }
      const toKey = `${destPrefix}${targetName}${isFolder ? '/' : ''}`;
      if (toKey === src) { skipped++; continue; }
      if (isFolder) {
        const items = await this.objects.walkAll(bucket.name, src, 400);
        for (const item of items) {
          const rel = item.key.slice(src.length);
          await this.objects.copy(bucket.name, item.key, `${toKey}${rel}`);
          if (mode === 'move') await this.objects.remove(bucket.name, item.key);
          moved++;
        }
        await this.objects.put(bucket.name, toKey, Buffer.alloc(0), 'application/x-directory');
        if (mode === 'move') await this.objects.remove(bucket.name, src);
      } else {
        await this.objects.copy(bucket.name, src, toKey);
        if (mode === 'move') await this.objects.remove(bucket.name, src);
        moved++;
      }
      changedRanges.push({ from: src, to: toKey });
    }
    // Mirror renames/moves into the registry table (best effort).
    for (const ch of changedRanges) {
      const rows = await this.prisma.storageObject.findMany({ where: { bucketId: bucket.id, key: { startsWith: ch.from } } });
      for (const row of rows) {
        await this.prisma.storageObject.update({
          where: { id: row.id },
          data: { key: ch.to + row.key.slice(ch.from.length) },
        }).catch(() => null);
      }
    }
    await this.log(ws.id, mode === 'move' ? 'Objects moved (Garage)' : 'Objects copied (Garage)', `${bucket.name} · ${moved} object(s) processed`);
    return { mode, moved, skipped };
  }

  @Put('buckets/:bucketId/object')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  async upload(
    @CurrentUser() user: { userId: string },
    @Param('bucketId') bucketId: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('prefix') prefixRaw = '',
  ) {
    const { ws, bucket } = await this.ownBucket(user.userId, bucketId);
    if (!file?.buffer?.length) throw new BadRequestException('No file in request.');
    const prefix = this.safePrefix(prefixRaw);
    const key = `${prefix}${this.safeName(file.originalname)}`;
    await this.objects.put(bucket.name, key, file.buffer, file.mimetype || 'application/octet-stream');
    const prev = await this.prisma.storageObject.findFirst({ where: { bucketId: bucket.id, key } });
    if (prev) await this.prisma.storageObject.delete({ where: { id: prev.id } });
    await this.prisma.storageObject.create({
      data: {
        workspaceId: ws.id,
        bucketId: bucket.id,
        key,
        size: file.size,
        type: file.mimetype || 'application/octet-stream',
        isFolder: false,
      },
    });
    await this.log(ws.id, 'Object uploaded (Garage)', `${bucket.name}/${key} · ${file.size} bytes`);
    return { key, size: file.size, bucket: bucket.name };
  }

  @Get('buckets/:bucketId/download')
  async download(
    @CurrentUser() user: { userId: string },
    @Param('bucketId') bucketId: string,
    @Query('key') keyRaw = '',
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { bucket } = await this.ownBucket(user.userId, bucketId);
    const key = String(keyRaw ?? '');
    if (!key || key.includes('..') || key.endsWith('/')) throw new BadRequestException('Invalid object key.');
    const obj = await this.objects.get(bucket.name, key);
    res.set({
      'Content-Type': obj.type,
      'Content-Disposition': `attachment; filename="${this.safeName(key)}"`,
    });
    if (obj.length > 0) res.set('Content-Length', String(obj.length));
    return new StreamableFile(obj.body as never);
  }

  @Post('buckets/:bucketId/folder')
  async folder(
    @CurrentUser() user: { userId: string },
    @Param('bucketId') bucketId: string,
    @Query('prefix') prefixRaw = '',
    @Query('name') nameRaw = '',
  ) {
    const { ws, bucket } = await this.ownBucket(user.userId, bucketId);
    const prefix = this.safePrefix(prefixRaw);
    const name = String(nameRaw ?? '').trim();
    if (!/^[a-zA-Z0-9._-]{1,60}$/.test(name)) throw new BadRequestException('Invalid folder name.');
    const key = `${prefix}${name}/`;
    await this.objects.put(bucket.name, key, Buffer.alloc(0), 'application/x-directory');
    const prev = await this.prisma.storageObject.findFirst({ where: { bucketId: bucket.id, key } });
    if (!prev) {
      await this.prisma.storageObject.create({
        data: { workspaceId: ws.id, bucketId: bucket.id, key, size: 0, type: 'application/x-folder', isFolder: true },
      });
    }
    await this.log(ws.id, 'Folder created (Garage)', `${bucket.name}/${key}`);
    return { key, bucket: bucket.name };
  }

  @Delete('buckets/:bucketId/object')
  async remove(
    @CurrentUser() user: { userId: string },
    @Param('bucketId') bucketId: string,
    @Query('key') keyRaw = '',
    @Query('folder') folderRaw = '',
  ) {
    const { ws, bucket } = await this.ownBucket(user.userId, bucketId);
    const key = String(keyRaw ?? '');
    if (!key || key.includes('..')) throw new BadRequestException('Invalid object key.');
    const folder = folderRaw === '1' || key.endsWith('/');
    if (folder) {
      const prefix = key.endsWith('/') ? key : `${key}/`;
      const removed = await this.objects.removeFolder(bucket.name, prefix);
      await this.prisma.storageObject.deleteMany({ where: { bucketId: bucket.id, key: { startsWith: prefix } } });
      await this.log(ws.id, 'Folder deleted (Garage)', `${bucket.name}/${prefix} · ${removed} objects removed`);
      return { removed, folder: true };
    }
    await this.objects.remove(bucket.name, key);
    await this.prisma.storageObject.deleteMany({ where: { bucketId: bucket.id, key } });
    await this.log(ws.id, 'Object deleted (Garage)', `${bucket.name}/${key}`);
    return { removed: 1, folder: false };
  }
}
