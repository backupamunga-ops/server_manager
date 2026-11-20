import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma.service.js';

/**
 * Internal endpoints for the cloudlane-mail-stack service (SMTP in/out).
 * Guarded by a shared token instead of the session guard — the caller is
 * the local mail-stack daemon on this VPS, not a browser.
 */
@ApiTags('mail')
@Controller('mail')
export class MailStackController {
  constructor(private readonly prisma: PrismaService) {}

  private tokenOk(header: string | undefined): boolean {
    const expected = process.env.MAIL_STACK_TOKEN || '';
    const got = String(header ?? '');
    if (!expected || !got) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private assertToken(header: string | undefined): void {
    if (!this.tokenOk(header)) throw new BadRequestException('Invalid mail-stack token.');
  }

  /** Mailbox registry for RCPT-time rejection of unknown recipients. */
  @Get('registry')
  async registry(@Headers('x-mail-stack-token') token: string | undefined) {
    this.assertToken(token);
    const zones = await this.prisma.domainZone.findMany();
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    const boxes = await this.prisma.mailbox.findMany();
    return {
      mailboxes: boxes.map((b) => {
        const zone = zoneById.get(b.zoneId);
        return { email: `${b.local}@${zone?.name ?? ''}`, workspaceId: zone?.workspaceId ?? '' };
      }).filter((m) => m.email.endsWith('@') === false),
    };
  }

  /** Store an inbound SMTP message into the recipient's mailbox. */
  @Post('inbound')
  async inbound(
    @Headers('x-mail-stack-token') token: string | undefined,
    @Body() body: { rcptTo?: string; mailFrom?: string; subject?: string; text?: string; html?: string; messageId?: string },
  ) {
    this.assertToken(token);
    const rcptTo = String(body?.rcptTo ?? '').toLowerCase().trim();
    const mailFrom = String(body?.mailFrom ?? '').trim();
    const subject = String(body?.subject ?? '').trim() || '(no subject)';
    const rawLocal = rcptTo.split('@')[0] ?? '';
    const domain = rcptTo.split('@')[1] ?? '';
    if (!rawLocal || !domain) throw new BadRequestException('Invalid recipient.');
    const zone = await this.prisma.domainZone.findFirst({ where: { name: domain } });
    if (!zone) throw new BadRequestException('Unknown recipient domain.');
    const mailbox = await this.prisma.mailbox.findFirst({ where: { zoneId: zone.id, local: rawLocal } });
    if (!mailbox) throw new BadRequestException('Unknown recipient mailbox.');
    const text = String(body?.text ?? '') || String(body?.html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const localFrom = mailFrom.split('@')[0] ?? mailFrom;
    const fromName = `${localFrom.charAt(0).toUpperCase()}${localFrom.slice(1)}`;
    const row = await this.prisma.mailMessage.create({
      data: {
        workspaceId: zone.workspaceId,
        accountEmail: rcptTo,
        folder: 'inbox',
        fromName,
        fromEmail: mailFrom,
        toEmail: rcptTo,
        subject,
        body: text,
        snippet: text.replace(/\s+/g, ' ').slice(0, 95),
        labels: JSON.stringify(['External']),
        thread: body?.messageId ? JSON.stringify([{ from: mailFrom, snippet: `Received via SMTP (${body.messageId})` }]) : JSON.stringify([]),
        unread: true,
      },
    });
    return { stored: true, id: row.id };
  }
}
