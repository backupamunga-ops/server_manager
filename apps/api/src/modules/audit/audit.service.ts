import { randomUUID } from 'node:crypto';
import type { AuditAction } from '@cloudlane/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service.js';

export interface AuditContext {
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'agent' | 'github';
  workspaceId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    action: AuditAction,
    status: 'success' | 'denied' | 'error',
    ctx: AuditContext = {},
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: ctx.actorUserId ?? null,
          actorType: ctx.actorType ?? 'system',
          workspaceId: ctx.workspaceId ?? null,
          resourceType: ctx.resourceType ?? null,
          resourceId: ctx.resourceId ?? null,
          action,
          status,
          ipAddress: ctx.ipAddress ?? null,
          correlationId: ctx.correlationId ?? randomUUID(),
          metadata: (ctx.metadata || undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      // Audit failures must never crash the request
      this.logger.error(
        `Failed to record audit event: action=${action} status=${status} err=${(err as Error).message}`,
      );
    }
  }

  /**
   * List audit events for the owner's workspace with keyset pagination.
   * Single-workspace installation in Phase 1+2: scope by the owner's workspace.
   */
  async list(
    userId: string,
    opts: { resourceType?: string; resourceId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const owner = await this.prisma.workspace.findFirst({ where: { ownerId: userId } });
    if (!owner) return { items: [], nextCursor: null };
    const where = {
      workspaceId: owner.id,
      ...(opts.resourceType ? { resourceType: opts.resourceType } : {}),
      ...(opts.resourceId ? { resourceId: opts.resourceId } : {}),
      ...(opts.cursor ? { id: { lt: opts.cursor } } : {}),
    };
    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((e) => ({
      id: e.id,
      action: e.action,
      status: e.status,
      actorType: e.actorType,
      actorUserId: e.actorUserId,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      ipAddress: e.ipAddress,
      correlationId: e.correlationId,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    }));
    return {
      items,
      nextCursor: hasMore ? String(rows[limit - 1].id) : null,
    };
  }
}
