import { randomUUID } from 'node:crypto';
import type { AuditAction } from '@cloudlane/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma.service.js';

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
          metadata: (ctx.metadata || undefined) as any,
        },
      });
    } catch (err) {
      // Audit failures must never crash the request
      this.logger.error(
        `Failed to record audit event: action=${action} status=${status} err=${(err as Error).message}`,
      );
    }
  }
}
