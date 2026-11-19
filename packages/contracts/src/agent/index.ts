/**
 * Go agent typed command contract.
 *
 * Wire format: JSON over UNIX domain socket at /run/cloudlane/agent.sock
 * Authentication: HMAC SHA-256 signature using shared key derived from
 *                 installation identity.
 *
 * The Go agent maintains a mirror of these types in agent/internal/ipc/types.go.
 * Any change here MUST be reflected there.
 */

export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentOperation =
  | 'release.startCandidate'
  | 'release.stop'
  | 'release.inspect'
  | 'release.activate'
  | 'caddy.reload'
  | 'caddy.validate'
  | 'volume.create'
  | 'volume.delete';

export interface AgentCommand {
  /** Protocol version. Must be 1. */
  version: typeof AGENT_PROTOCOL_VERSION;
  /** UUID v4, unique per command. Used for idempotency. */
  commandId: string;
  /** Must match InstallationIdentity.instanceId on the agent. */
  serverId: string;
  /** Workspace that owns the resource. Agent verifies resource belongs to this. */
  workspaceId: string;
  /** Must be in the allowlist above. Anything else is rejected. */
  operation: AgentOperation;
  /** Deployment ID, volume ID, etc. — the resource being acted on. */
  resourceId: string;
  /** Operation-specific payload. Schema varies by operation. */
  payload: Record<string, unknown>;
  /** RFC3339 timestamp when command was issued. */
  issuedAt: string;
  /** RFC3339 timestamp when command expires. Max 60s from issuedAt. */
  expiresAt: string;
  /** HMAC SHA-256 signature over canonical JSON of all fields above (excluding signature). */
  signature: string;
}

export type AgentResponseStatus = 'accepted' | 'completed' | 'failed' | 'rejected';

export interface AgentResponse {
  commandId: string;
  status: AgentResponseStatus;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  observedAt: string;
}

// ============ Operation payloads ============

export interface ReleaseStartCandidatePayload {
  imageDigest: string | null; // null for static ZIP deploys using caddy:2-alpine
  imageRef: string; // e.g. "ghcr.io/backupamunga-ops/myapp:abc123" or "caddy:2-alpine"
  cpuLimit: number; // cores, e.g. 0.25
  memoryLimitMiB: number; // e.g. 160
  internalPort: number; // e.g. 3000
  envVarsHash: string; // sha256 of env vars blob (vars themselves never sent to agent)
  volumeIds: string[];
  staticArtifactPath?: string; // for ZIP static deploys, path in Garage bucket
}

export interface ReleaseStopPayload {
  containerId: string;
}

export interface ReleaseInspectPayload {
  deploymentId: string;
}

export interface ReleaseInspectResult {
  containerId: string;
  state: 'running' | 'stopped' | 'exited' | 'not_found';
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  observedAt: string;
  memoryUsageMiB?: number;
  cpuUsagePercent?: number;
}

export interface CaddyReloadPayload {
  configSha256: string;
  configPath: string; // absolute path to new Caddyfile fragment
}

export interface CaddyValidatePayload {
  configPath: string;
}

export interface VolumeCreatePayload {
  volumeId: string;
  name: string;
  mountPath: string; // must be in /data, /uploads, /cache allowlist
  quotaMB: number;
}

export interface VolumeDeletePayload {
  volumeId: string;
}

// ============ Error codes ============

export type AgentErrorCode =
  | 'SIGNATURE_INVALID'
  | 'EXPIRED'
  | 'SERVER_ID_MISMATCH'
  | 'OPERATION_NOT_ALLOWED'
  | 'RESOURCE_NOT_FOUND'
  | 'PAYLOAD_INVALID'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'DOCKER_ERROR'
  | 'CADDY_ERROR';
