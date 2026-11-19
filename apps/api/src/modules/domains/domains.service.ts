import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns';
import { promisify } from 'node:util';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

const resolveTxtAsync = promisify(resolveTxt) as (host: string) => Promise<string[][]>;

const HOST_PATTERN = /^(\*\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)[a-z]{2,}$/i;

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** One-field Add Domain (master guide §06): creates a PENDING zone in Manual DNS. */
  async add(userId: string, hostInput: string) {
    const host = hostInput.trim().toLowerCase().replace(/\.$/, '');
    if (!HOST_PATTERN.test(host)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Enter a valid domain name, e.g. example.com.',
      });
    }
    const workspace = await this.prisma.workspace.findFirst({ where: { ownerId: userId } });
    if (!workspace) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Workspace not found.' });
    }
    const existing = await this.prisma.domain.findUnique({ where: { host } });
    if (existing) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: `Domain ${host} is already attached.`,
      });
    }

    const domain = await this.prisma.domain.create({
      data: {
        workspaceId: workspace.id,
        host,
        verificationToken: `cloudlane-verify=${randomBytes(24).toString('hex')}`,
      },
    });

    await this.audit.record('DOMAIN_ADDED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId: workspace.id,
      resourceType: 'domain',
      resourceId: domain.id,
      metadata: { host },
    });

    return this.serialize(domain);
  }

  /** List all domains for the owner's workspace. */
  async list(userId: string) {
    const workspace = await this.prisma.workspace.findFirst({ where: { ownerId: userId } });
    if (!workspace) return { items: [] };
    const rows = await this.prisma.domain.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
    });
    return { items: rows.map((d) => this.serialize(d)) };
  }

  /** Domain detail incl. DNS instructions (records to publish). */
  async get(userId: string, domainId: string) {
    const domain = await this.requireOwned(userId, domainId);
    return {
      ...this.serialize(domain),
      dnsInstructions: {
        challenge: {
          type: 'TXT',
          name: `_cloudlane-challenge.${domain.host}`,
          value: domain.verificationToken,
          purpose: 'Proves control of the domain for verification.',
        },
        apex: {
          type: 'A',
          name: domain.host.replace(/^\*\./, ''),
          value: '@current-server-ipv4',
          purpose: 'Points the hostname at this installation (update with the panel IP).',
        },
      },
    };
  }

  /**
   * Verify domain ownership via a TXT record lookup. Manual DNS: the owner
   * publishes `_cloudlane-challenge.<host> TXT <token>` at their DNS provider.
   */
  async verify(userId: string, domainId: string) {
    const domain = await this.requireOwned(userId, domainId);
    const challengeHost = `_cloudlane-challenge.${domain.host}`;

    let found = false;
    let lastError = '';
    try {
      const records = await resolveTxtAsync(challengeHost);
      found = records.some((chunks) => chunks.join('') === domain.verificationToken);
      if (!found) lastError = `Challenge TXT record not found at ${challengeHost}.`;
    } catch (err) {
      lastError = `DNS lookup failed: ${(err as Error).message}`;
    }

    const updated = await this.prisma.domain.update({
      where: { id: domain.id },
      data: {
        status: found ? 'VERIFIED' : 'FAILED',
        verifiedAt: found ? new Date() : null,
        lastCheckedAt: new Date(),
        lastError: found ? null : lastError,
      },
    });

    await this.audit.record(
      found ? 'DOMAIN_VERIFIED' : 'DOMAIN_VERIFY_FAILED',
      found ? 'success' : 'error',
      {
        actorType: 'user',
        actorUserId: userId,
        resourceType: 'domain',
        resourceId: domain.id,
        metadata: { host: domain.host, lastError },
      },
    );

    return { ...this.serialize(updated), lastError: lastError || null };
  }

  /** Set the DNS mode under domain Settings (staged, not immediate; §06). */
  async setDnsMode(userId: string, domainId: string, mode: 'MANUAL' | 'MANAGED') {
    const domain = await this.requireOwned(userId, domainId);
    const updated = await this.prisma.domain.update({
      where: { id: domain.id },
      data: { dnsMode: mode },
    });
    await this.audit.record('DOMAIN_DNS_MODE_SET', 'success', {
      actorType: 'user',
      actorUserId: userId,
      resourceType: 'domain',
      resourceId: domain.id,
      metadata: { host: domain.host, mode },
    });
    return this.serialize(updated);
  }

  async remove(userId: string, domainId: string) {
    const domain = await this.requireOwned(userId, domainId);
    await this.prisma.domain.delete({ where: { id: domain.id } });
    await this.audit.record('DOMAIN_REMOVED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      resourceType: 'domain',
      resourceId: domainId,
      metadata: { host: domain.host },
    });
    return { id: domainId, deleted: true };
  }

  private async requireOwned(userId: string, domainId: string) {
    const domain = await this.prisma.domain.findUnique({
      where: { id: domainId },
      include: { workspace: true },
    });
    if (!domain || domain.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Domain not found.' });
    }
    return domain;
  }

  private serialize(d: {
    id: string;
    host: string;
    status: string;
    dnsMode: string;
    verifiedAt: Date | null;
    lastCheckedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
  }) {
    return {
      id: d.id,
      host: d.host,
      status: d.status,
      dnsMode: d.dnsMode,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
      lastError: d.lastError,
      createdAt: d.createdAt.toISOString(),
    };
  }
}
