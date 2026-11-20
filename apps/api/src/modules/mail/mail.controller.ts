import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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
import { Response } from 'express';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { PrismaService } from '../../common/prisma.service.js';
import { StorageObjectsService } from '../storage/storage-objects.service.js';

/**
 * Workspace mailbox message store for the Drevanta Mail tool window.
 * Messages live in Postgres; sending between workspace mailboxes delivers
 * for real. External recipients go through the mail-stack service
 * (SMTP + MX) when it is running; otherwise the message is kept in Sent
 * and reported as not delivered. Attachments are objects under the
 * reserved `.mail/attachments/` prefix in the workspace bucket.
 */
@ApiTags('mail')
@Controller('mail')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class MailController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly objects: StorageObjectsService,
  ) {}

  private readonly MAIL_PREFIX = '.mail/attachments/';

  private async ws(userId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { ownerId: userId } });
    if (!ws) throw new BadRequestException('Workspace not found.');
    return ws;
  }

  /** First workspace bucket (raw query — resilient to model changes). */
  private async mailBucket(wsId: string): Promise<string> {
    const rows = await this.prisma.$queryRaw<Array<{ name: string }>>(
      `SELECT name FROM "Bucket" WHERE "workspaceId" = ${wsId} ORDER BY "createdAt" ASC LIMIT 1`,
    );
    if (!rows?.length) throw new BadRequestException('No storage bucket in this workspace — create one to enable attachments.');
    return rows[0].name;
  }

  /** Registry mailboxes for this workspace, mapped to the tool's account model. */
  private async workspaceMailboxes(wsId: string) {
    const zones = await this.prisma.domainZone.findMany({ where: { workspaceId: wsId } });
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    const boxes = await this.prisma.mailbox.findMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
    return boxes.map((b) => {
      const zone = zoneById.get(b.zoneId);
      const email = `${b.local}@${zone?.name ?? ''}`;
      const label = zone?.name?.split('.')[0] ?? 'Workspace';
      return {
        email,
        name: `${b.local.charAt(0).toUpperCase()}${b.local.slice(1)} · ${label}`,
        short: label.charAt(0).toUpperCase() + label.slice(1),
      };
    });
  }

  private displayName(email: string, boxes: Array<{ email: string }>): string {
    const local = String(email).split('@')[0] ?? email;
    return `${local.charAt(0).toUpperCase()}${local.slice(1)}`;
  }

  private parse<T>(raw: string, fallback: T): T {
    try {
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Validate an attachment list coming from the client. */
  private cleanAttachments(input: unknown): Array<{ key: string; name: string; size: string }> {
    if (!Array.isArray(input)) return [];
    return input
      .filter((a): a is { key: string; name: string; size: string } =>
        !!a && typeof (a as { key?: unknown }).key === 'string')
      .map((a) => ({
        key: String(a.key),
        name: String(a.name ?? 'file').slice(0, 120),
        size: String(a.size ?? ''),
      }))
      .filter((a) => a.key.startsWith(this.MAIL_PREFIX) && !a.key.includes('..') && a.key.length < 400)
      .slice(0, 5);
  }

  private toTool(m: {
    id: number; accountEmail: string; folder: string; fromName: string; fromEmail: string;
    toEmail: string; subject: string; body: string; snippet: string; labels: string;
    attachments: string; thread: string; priority: boolean; unread: boolean; starred: boolean; createdAt: Date;
  }) {
    return {
      id: m.id,
      account: m.accountEmail,
      folder: m.folder,
      from: m.fromName,
      email: m.fromEmail,
      to: m.toEmail,
      subject: m.subject,
      snippet: m.snippet,
      body: m.body,
      date: m.createdAt.toISOString(),
      unread: m.unread,
      starred: m.starred,
      priority: m.priority,
      labels: this.parse<string[]>(m.labels, []),
      attachments: this.parse<Array<{ key?: string; name: string; size: string }>>(m.attachments, []),
      thread: this.parse<Array<{ from: string; snippet: string }>>(m.thread, []),
    };
  }

  private async seedIfEmpty(wsId: string, boxes: Array<{ email: string }>): Promise<void> {
    const count = await this.prisma.mailMessage.count({ where: { workspaceId: wsId } });
    if (count > 0 || !boxes.length) return;
    const first = boxes[0];
    await this.prisma.mailMessage.create({
      data: {
        workspaceId: wsId,
        accountEmail: first.email,
        folder: 'inbox',
        fromName: 'Drevanta Platform',
        fromEmail: 'no-reply@drevanta.cloud',
        toEmail: first.email,
        subject: 'Your mailbox is live',
        snippet: 'Internal delivery between your workspace mailboxes works today.',
        body: 'Hello,\n\nThis mailbox is connected to the workspace registry. Sending between mailboxes on your domains delivers for real.\n\nExternal delivery runs through the mail stack (SMTP + MX + DKIM) once the stack service is running on this VPS.\n\n— Drevanta Platform',
        labels: JSON.stringify(['Infrastructure']),
        unread: true,
        priority: true,
      },
    });
    if (boxes[1]) {
      await this.prisma.mailMessage.create({
        data: {
          workspaceId: wsId,
          accountEmail: boxes[1].email,
          folder: 'inbox',
          fromName: 'Drevanta Platform',
          fromEmail: 'no-reply@drevanta.cloud',
          toEmail: boxes[1].email,
          subject: 'Welcome to workspace mail',
          snippet: 'This is a real stored message, not a demo row.',
          body: 'Hello,\n\nThis message is stored in the workspace database. Star it, archive it, or move it around — every change persists.\n\n— Drevanta Platform',
          labels: JSON.stringify([]),
          unread: true,
        },
      });
    }
  }

  @Get('accounts')
  async accounts(@CurrentUser() user: { userId: string }) {
    const ws = await this.ws(user.userId);
    return { accounts: await this.workspaceMailboxes(ws.id) };
  }

  @Get('messages')
  async messages(@CurrentUser() user: { userId: string }) {
    const ws = await this.ws(user.userId);
    const boxes = await this.workspaceMailboxes(ws.id);
    await this.seedIfEmpty(ws.id, boxes);
    const rows = await this.prisma.mailMessage.findMany({
      where: { workspaceId: ws.id },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { accounts: boxes, messages: rows.map((r) => this.toTool(r)) };
  }

  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadAttachment(
    @CurrentUser() user: { userId: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    const ws = await this.ws(user.userId);
    if (!file) throw new BadRequestException('No file in request.');
    const bucket = await this.mailBucket(ws.id);
    const safeName = String(file.originalname ?? 'file').replace(/[^\w. ()-]/g, '_').slice(0, 120) || 'file';
    const key = `${this.MAIL_PREFIX}${randomUUID()}-${safeName}`;
    await this.objects.put(bucket, key, file.buffer, file.mimetype || 'application/octet-stream');
    return { key, name: safeName, size: file.size, bucket };
  }

  @Get('attachments/download')
  async downloadAttachment(
    @CurrentUser() user: { userId: string },
    @Query('key') keyRaw = '',
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const ws = await this.ws(user.userId);
    const key = String(keyRaw ?? '');
    if (!key.startsWith(this.MAIL_PREFIX) || key.includes('..')) throw new BadRequestException('Invalid attachment key.');
    const bucket = await this.mailBucket(ws.id);
    const obj = await this.objects.get(bucket, key);
    res.set({
      'Content-Type': obj.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${key.split('/').pop() ?? 'attachment'}"`,
    });
    if (obj.length > 0) res.set('Content-Length', String(obj.length));
    return new StreamableFile(obj.body as never);
  }

  /** Try real SMTP delivery through the mail-stack service. */
  private async attemptExternalDelivery(
    fromEmail: string,
    to: string,
    subject: string,
    body: string,
    attachments: Array<{ key: string; name: string; size: string }>,
    bucket: string | null,
  ): Promise<{ delivered: boolean; warning: string | null }> {
    const base = process.env.MAIL_STACK_URL || 'http://127.0.0.1:3901';
    const token = process.env.MAIL_STACK_TOKEN || '';
    try {
      const res = await fetch(`${base}/outbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mail-stack-token': token },
        body: JSON.stringify({ from: fromEmail, to, subject, text: body, attachments, bucket }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) return { delivered: false, warning: `Mail stack refused the message (${res.status}).` };
      const data = (await res.json()) as { accepted?: string[]; error?: string };
      if (data.accepted && data.accepted.length > 0) return { delivered: true, warning: null };
      return { delivered: false, warning: data.error || 'SMTP server did not accept the message.' };
    } catch {
      return {
        delivered: false,
        warning: 'Mail stack service is not running on this VPS — the message is saved in Sent. Start cloudlane-mail-stack to enable external delivery.',
      };
    }
  }

  @Post('send')
  async send(
    @CurrentUser() user: { userId: string },
    @Body() body: { fromEmail?: string; to?: string; subject?: string; body?: string; attachments?: unknown },
  ) {
    const ws = await this.ws(user.userId);
    const boxes = await this.workspaceMailboxes(ws.id);
    const fromEmail = String(body?.fromEmail ?? '');
    const to = String(body?.to ?? '').trim();
    const subject = String(body?.subject ?? '').trim();
    const text = String(body?.body ?? '');
    if (!boxes.some((b) => b.email === fromEmail)) throw new BadRequestException('Unknown sending mailbox.');
    if (!to || !subject || !text) throw new BadRequestException('Recipient, subject, and body are required.');
    const attachments = this.cleanAttachments(body?.attachments);
    const senderName = this.displayName(fromEmail, boxes);
    const snippet = text.replace(/\s+/g, ' ').slice(0, 95);

    let bucket: string | null = null;
    if (attachments.length) {
      try { bucket = await this.mailBucket(ws.id); } catch { /* attachments kept as metadata only */ }
    }
    const sent = await this.prisma.mailMessage.create({
      data: {
        workspaceId: ws.id,
        accountEmail: fromEmail,
        folder: 'sent',
        fromName: senderName,
        fromEmail,
        toEmail: to,
        subject,
        body: text,
        snippet,
        attachments: JSON.stringify(attachments),
        unread: false,
      },
    });

    const recipient = boxes.find((b) => b.email.toLowerCase() === to.toLowerCase());
    if (recipient) {
      await this.prisma.mailMessage.create({
        data: {
          workspaceId: ws.id,
          accountEmail: recipient.email,
          folder: 'inbox',
          fromName: senderName,
          fromEmail,
          toEmail: to,
          subject,
          body: text,
          snippet,
          attachments: JSON.stringify(attachments),
        },
      });
      return { message: this.toTool(sent), delivered: true, warning: null };
    }

    const ext = await this.attemptExternalDelivery(fromEmail, to, subject, text, attachments, bucket);
    if (ext.delivered) {
      await this.prisma.mailMessage.update({
        where: { id: sent.id },
        data: { thread: JSON.stringify([{ from: to, snippet: 'Accepted for delivery by the mail stack.' }]) },
      });
    }
    return { message: this.toTool(sent), delivered: ext.delivered, warning: ext.warning };
  }

  @Post('drafts')
  async drafts(
    @CurrentUser() user: { userId: string },
    @Body() body: { fromEmail?: string; to?: string; subject?: string; body?: string; attachments?: unknown },
  ) {
    const ws = await this.ws(user.userId);
    const boxes = await this.workspaceMailboxes(ws.id);
    const fromEmail = String(body?.fromEmail ?? '');
    if (!boxes.some((b) => b.email === fromEmail)) throw new BadRequestException('Unknown sending mailbox.');
    const text = String(body?.body ?? '');
    const attachments = this.cleanAttachments(body?.attachments);
    const row = await this.prisma.mailMessage.create({
      data: {
        workspaceId: ws.id,
        accountEmail: fromEmail,
        folder: 'drafts',
        fromName: this.displayName(fromEmail, boxes),
        fromEmail,
        toEmail: String(body?.to ?? '').trim(),
        subject: String(body?.subject ?? '').trim() || '(no subject)',
        body: text,
        snippet: text.replace(/\s+/g, ' ').slice(0, 95),
        attachments: JSON.stringify(attachments),
        unread: false,
      },
    });
    return { message: this.toTool(row) };
  }

  @Patch('messages/:id')
  async update(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { folder?: string; starred?: boolean; unread?: boolean; subject?: string; body?: string; to?: string; attachments?: unknown },
  ) {
    const ws = await this.ws(user.userId);
    const row = await this.prisma.mailMessage.findFirst({ where: { id, workspaceId: ws.id } });
    if (!row) throw new BadRequestException('Message not found.');
    const data: Record<string, unknown> = {};
    const folders = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'];
    if (body?.folder && folders.includes(body.folder)) data.folder = body.folder;
    if (typeof body?.starred === 'boolean') data.starred = body.starred;
    if (typeof body?.unread === 'boolean') data.unread = body.unread;
    if (typeof body?.subject === 'string') data.subject = body.subject;
    if (typeof body?.body === 'string') {
      data.body = body.body;
      data.snippet = body.body.replace(/\s+/g, ' ').slice(0, 95);
    }
    if (typeof body?.to === 'string') data.toEmail = body.to;
    if (body?.attachments !== undefined) data.attachments = JSON.stringify(this.cleanAttachments(body.attachments));
    const updated = await this.prisma.mailMessage.update({ where: { id: row.id }, data });
    return { message: this.toTool(updated) };
  }

  @Delete('messages/:id')
  async remove(@CurrentUser() user: { userId: string }, @Param('id', ParseIntPipe) id: number) {
    const ws = await this.ws(user.userId);
    const row = await this.prisma.mailMessage.findFirst({ where: { id, workspaceId: ws.id } });
    if (!row) throw new BadRequestException('Message not found.');
    await this.prisma.mailMessage.delete({ where: { id: row.id } });
    return { removed: true };
  }
}
