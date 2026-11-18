/**
 * API request and response DTOs.
 * These are the canonical shapes that travel over /api/v1.
 * The NestJS DTOs (class-validator decorated) in apps/api mirror these.
 * The SvelteKit client consumes these directly.
 */

// ============ Installation & Bootstrap ============

export type InstallationStatus = 'unclaimed' | 'claimed' | 'active';

export interface InstallationStatusResponse {
  status: InstallationStatus;
  version: string;
  instanceId: string;
}

export interface ClaimRequest {
  claimCode: string;
}

export interface ClaimResponse {
  token: string;
  expiresAt: string; // RFC3339
}

export interface OwnerCreationRequest {
  email: string;
  password: string;
  workspaceName: string;
  mfaType: 'totp';
}

export interface OwnerCreationResponse {
  userId: string;
  workspaceId: string;
  mfaEnrollment: {
    factorId: string;
    secret: string; // base32 TOTP seed, shown once
    otpauthUrl: string;
  };
  recoveryCodes: string[]; // shown once
}

export interface MfaVerifyRequest {
  code: string;
}

// ============ Authentication ============

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  requiresMfa: true;
  mfaChallengeId: string;
}

export interface MfaVerifyLoginRequest {
  mfaChallengeId: string;
  code: string;
}

export interface SessionInfo {
  userId: string;
  email: string;
  role: 'OWNER';
  requiresStepUp: boolean;
  stepUpExpiresAt: string | null;
}

export interface ReauthenticateRequest {
  password?: string;
  mfaCode?: string;
}

export interface ReauthenticateResponse {
  stepUpExpiresAt: string;
}

export interface SessionListItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: string;
  current: boolean;
}

// ============ Projects & Services ============

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  serviceCount: number;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  services: ServiceSummary[];
}

export interface CreateProjectRequest {
  name: string;
  slug?: string;
}

export interface ServiceSummary {
  id: string;
  name: string;
  kind: 'application';
  role: 'web' | 'api' | 'worker' | 'static';
  source: 'zip' | 'github';
  framework: string;
  status: string;
  activeDeploymentId: string | null;
  createdAt: string;
}

export interface ServiceDetail extends ServiceSummary {
  projectId: string;
  environmentId: string;
  variables: { key: string }[];
  githubLink?: {
    repoFullName: string;
    branch: string;
    autoDeploy: boolean;
    lastRevision: string | null;
  };
  zipSource?: {
    sha256: string;
    fileSize: number;
    entryCount: number;
    detectedFramework: string;
  };
  activeDeployment?: DeploymentSummary | null;
}

export type ServiceRole = 'web' | 'api' | 'worker' | 'static';

export interface CreateServiceFromZipRequest {
  kind: 'application';
  role: ServiceRole;
  source: 'zip';
  name: string;
  uploadId: string;
  framework?: string;
}

export interface CreateServiceFromGithubRequest {
  kind: 'application';
  role: ServiceRole;
  source: 'github';
  name: string;
  installationId: number;
  repoFullName: string;
  branch: string;
  autoDeploy: boolean;
}

export type CreateServiceRequest = CreateServiceFromZipRequest | CreateServiceFromGithubRequest;

export interface CreateServiceResponse {
  serviceId: string;
  deploymentId: string;
}

// ============ Deployments ============

export type DeploymentStatus =
  | 'REQUESTED'
  | 'QUEUED'
  | 'FETCHING'
  | 'VALIDATING'
  | 'DETECTING'
  | 'BUILDING'
  | 'STARTING_CANDIDATE'
  | 'HEALTH_CHECKING'
  | 'ACTIVATING'
  | 'LIVE'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'ROLLED_BACK';

export interface DeploymentSummary {
  id: string;
  status: DeploymentStatus;
  revision: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface DeploymentEvent {
  id: string;
  deploymentId: string;
  stage: DeploymentStatus;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  createdAt: string;
}

export interface RollbackRequest {
  deploymentId: string;
}

// ============ Uploads ============

export interface UploadInitRequest {
  filename: string;
  size: number;
  mimeType: string;
}

export interface UploadInitResponse {
  uploadId: string;
  uploadUrl: string; // presigned Garage S3 URL
  expiresAt: string;
}

export interface UploadFinalizeRequest {
  sha256: string;
}

export interface UploadFinalizeResponse {
  uploadId: string;
  validated: true;
  detectedFramework: string;
  entryCount: number;
}

// ============ Variables ============

export interface CreateVariableRequest {
  key: string;
  value: string;
}

// ============ Audit & Operations ============

export type AuditAction =
  | 'CLAIM_ISSUED'
  | 'CLAIM_VERIFIED'
  | 'CLAIM_FAILED'
  | 'OWNER_CREATED'
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGOUT'
  | 'MFA_ENROLLED'
  | 'MFA_VERIFIED'
  | 'RECOVERY_CODE_USED'
  | 'SESSION_REVOKED'
  | 'API_KEY_CREATED'
  | 'API_KEY_REVOKED'
  | 'PROJECT_CREATED'
  | 'PROJECT_DELETED'
  | 'SERVICE_CREATED'
  | 'DEPLOYMENT_STARTED'
  | 'DEPLOYMENT_LIVE'
  | 'DEPLOYMENT_FAILED'
  | 'DEPLOYMENT_ROLLED_BACK'
  | 'VARIABLE_ADDED'
  | 'VARIABLE_REMOVED'
  | 'AGENT_COMMAND_SENT'
  | 'AGENT_COMMAND_REJECTED';

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorType: 'user' | 'system' | 'agent' | 'github';
  workspaceId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  action: AuditAction;
  status: 'success' | 'denied' | 'error';
  ipAddress: string | null;
  correlationId: string | null;
  createdAt: string;
}

export interface AuditEventList {
  items: AuditEvent[];
  nextCursor: string | null;
}

export type OperationStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface Operation {
  id: string;
  status: OperationStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// ============ Error envelope ============

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

// ============ GitHub App ============

export interface GithubInstallUrlResponse {
  installUrl: string;
  state: string;
}

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GithubInstallationCallbackQuery {
  installation_id: string;
  code: string;
  state: string;
}
