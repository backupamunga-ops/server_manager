/**
 * Audit event types and operation types.
 * These mirror the Prisma enums in apps/api/src/prisma/schema.prisma.
 * Any change there MUST be reflected here.
 */

export type { AuditAction, OperationStatus } from '../api/index.js';
export interface AuditEventInput {
  actorUserId: string | null;
  actorType: 'user' | 'system' | 'agent' | 'github';
  workspaceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  action: import('../api/index.js').AuditAction;
  status: 'success' | 'denied' | 'error';
  ipAddress: string | null;
  correlationId: string | null;
  metadata?: Record<string, unknown>;
}

export interface OperationInput {
  idempotencyKey: string;
  resourceType: string;
  resourceId: string;
  operationType: string;
  payload: Record<string, unknown>;
}

// ============ Deployment lifecycle events ============

export interface DeploymentStageEvent {
  deploymentId: string;
  stage: import('../api/index.js').DeploymentStatus;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}
