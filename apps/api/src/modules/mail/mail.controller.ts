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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Real mailbox message store for the Aster Mail tool window. Messages live in
 * Postgres; sending between workspace mailboxes delivers for real. External
 * recipients are accepted into Sent but reported as not delivered until the
 * mail stack (MX + SMTP) ships.
 */
@ApiTags('mail')
@Controller('mail')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class MailController {
  constructor(private readonly prisma: PrismaService) {}

  private async ws(userId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { ownerId: userId } });
    if (!ws) throw new BadRequestException('Workspace not found.');
    return ws;
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

  private displayName(email: string, boxes: Array<{ email: string; name: string }>): string {
    const own = boxes.find((b) => b.email === email);
    if (own) {
      const local = email.split('@')[0] ?? email;
      return `${local.charAt(0).toUpperCase()}${local.slice(1)}`;
    }
    return email;
  }

  private parse<T>(raw: string, fallback: T): T {
    try {
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch {
      return fallback;
    }
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
      attachments: this.parse<Array<{ name: string; size: string }>>(m.attachments, []),
      thread: this.parse<Array<{ from: string; snippet: string }>>(m.thread, []),
    };
  }

  private async seedIfEmpty(wsId: string, boxes: Array<{ email: string; name: string }>): Promise<void> {
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
        body: 'Hello,\n\nThis mailbox is connected to the workspace registry. Sending between mailboxes on your domains delivers for real.\n\nExternal delivery (Gmail, Outlook, etc.) waits for the mail stack — SMTP + MX — which is on the roadmap.\n\n— Drevanta Platform',
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

  @Post('send')
  async send(
    @CurrentUser() user: { userId: string },
    @Body() body: { fromEmail?: string; to?: string; subject?: string; body?: string },
  ) {
    const ws = await this.ws(user.userId);
    const boxes = await this.workspaceMailboxes(ws.id);
    const fromEmail = String(body?.fromEmail ?? '');
    const to = String(body?.to ?? '').trim();
    const subject = String(body?.subject ?? '').trim();
    const text = String(body?.body ?? '');
    if (!boxes.some((b) => b.email === fromEmail)) throw new BadRequestException('Unknown sending mailbox.');
    if (!to || !subject || !text) throw new BadRequestException('Recipient, subject, and body are required.');
    const senderName = this.displayName(fromEmail, boxes);
    const snippet = text.replace(/\s+/g, ' ').slice(0, 95);
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
        },
      });
      await this.prisma.mailMessage.update({ where: { id: sent.id }, data: { thread: JSON.stringify([{ from: recipient.email, snippet: 'Delivered to this workspace mailbox.' }]) } });
      return { message: this.toTool(sent), delivered: true, warning: null };
    }
    return {
      message: this.toTool(sent),
      delivered: false,
      warning: `${to} is outside this workspace — external delivery starts with the mail stack (SMTP + MX).`,
    };
  }

  @Post('drafts')
  async drafts(
    @CurrentUser() user: { userId: string },
    @Body() body: { fromEmail?: string; to?: string; subject?: string; body?: string },
  ) {
    const ws = await this.ws(user.userId);
    const boxes = await this.workspaceMailboxes(ws.id);
    const fromEmail = String(body?.fromEmail ?? '');
    if (!boxes.some((b) => b.email === fromEmail)) throw new BadRequestException('Unknown sending mailbox.');
    const text = String(body?.body ?? '');
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
        unread: false,
      },
    });
    return { message: this.toTool(row) };
  }

  @Patch('messages/:id')
  async update(
    @CurrentUser() user: { userId: string },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { folder?: string; starred?: boolean; unread?: boolean; subject?: string; body?: string; to?: string },
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
