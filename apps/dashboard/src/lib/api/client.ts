/**
 * Cloudlane API client — same-origin fetch with cookie sessions (build plan §4).
 * credentials: include on every call; typed error envelope; no token storage.
 */

const BASE = '/api/v1';

export class ApiError extends Error {
  code: string;
  status: number;
  requestId?: string;
  details?: unknown;
  constructor(status: number, body: { code?: string; message?: string; requestId?: string; details?: unknown }) {
    super(body?.message ?? `Request failed (HTTP ${status})`);
    this.status = status;
    this.code = body?.code ?? 'UNKNOWN';
    this.requestId = body?.requestId;
    this.details = body?.details;
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload: Record<string, unknown> = {};
    try {
      payload = await res.json();
    } catch {
      /* empty body */
    }
    const envelope = (payload.error ?? payload) as Record<string, unknown>;
    throw new ApiError(res.status, envelope);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

const get = <T,>(path: string) => request<T>('GET', path);
const post = <T,>(path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>('POST', path, body, headers);
const put = <T,>(path: string, body?: unknown) => request<T>('PUT', path, body);
const del = <T,>(path: string) => request<T>('DELETE', path);
/** Raw-body PUT with same-origin credentials (multipart-free uploads use this). */
async function putForm(path: string, form: FormData): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    let payload: Record<string, unknown> = {};
    try { payload = await res.json(); } catch { /* empty body */ }
    const envelope = (payload.error ?? payload) as Record<string, unknown>;
    throw new ApiError(res.status, envelope);
  }
}

async function putRaw(path: string, body: ArrayBuffer): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!res.ok) {
    let payload: Record<string, unknown> = {};
    try { payload = await res.json(); } catch { /* empty body */ }
    const envelope = (payload.error ?? payload) as Record<string, unknown>;
    throw new ApiError(res.status, envelope);
  }
}

// ---------- shared shapes ----------

export interface SessionInfo {
  userId: string;
  email: string;
  role: string;
  requiresStepUp?: boolean;
  stepUpExpiresAt?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  serviceCount?: number;
  createdAt: string;
}

export interface DeploymentSummary {
  id: string;
  status: string;
  revision: string;
  startedAt: string;
  finishedAt: string | null;
  errorMessage?: string | null;
}

export interface DeploymentEvent {
  id: string;
  deploymentId: string;
  stage: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  createdAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  modified: string;
}

export interface ServiceDetail {
  id: string;
  name: string;
  kind: string;
  role: string;
  source: 'zip' | 'github';
  framework: string;
  status: string;
  observedState?: string;
  activeDeploymentId: string | null;
  createdAt: string;
  projectId: string;
  environmentId: string;
  variables: { key: string }[];
  githubLink?: { repoFullName: string; branch: string; autoDeploy: boolean; lastRevision: string | null };
  zipSource?: { sha256: string; fileSize: number; entryCount: number; detectedFramework: string };
  activeDeployment: DeploymentSummary | null;
}

export interface ServiceVariable {
  key: string;
  value: string;
  updatedAt: string;
}

export interface DomainInfo {
  id: string;
  host: string;
  status: 'PENDING' | 'VERIFIED' | 'FAILED';
  dnsMode: 'MANUAL' | 'MANAGED';
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  dnsInstructions?: {
    challenge: { type: string; name: string; value: string; purpose: string };
    apex: { type: string; name: string; value: string; purpose: string };
  };
}

export interface AuditEventInfo {
  id: string;
  action: string;
  status: string;
  actorType: string;
  resourceType: string | null;
  resourceId: string | null;
  createdAt: string;
}

export interface OverviewData {
  workspace: { id: string; name: string } | null;
  stats: { projects: number; services: number; live: number; failed: number };
  projects: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
    services: {
      id: string;
      name: string;
      framework: string;
      source: string;
      observedState: string;
      activeDeploymentId: string | null;
      activeDeploymentStatus: string | null;
      url: string | null;
    }[];
  }[];
  recentActivity: AuditEventInfo[];
}

export interface ServerInfo {
  version: string;
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  memoryTotalMiB: number;
  memoryFreeMiB: number;
  nodeVersion: string;
}

export interface SessionRow {
  sessionId: string;
  ip: string;
  userAgent: string;
  lastSeenAt: string;
  current: boolean;
}

// ---------- API surface ----------

export const api = {
  get,
  post,
  del,
  putForm,
  putRaw,
  installation: {
    status: () => get<{ status: string; version: string }>('/installation/status'),
  },

  auth: {
    login: (email: string, password: string) =>
      post<{ requiresMfa: boolean; mfaChallengeId?: string }>('/auth/login', { email, password }),
    mfaVerify: (mfaChallengeId: string, code: string) =>
      post<{ ok?: boolean }>('/auth/mfa/verify', { mfaChallengeId, code }),
    session: () => get<SessionInfo>('/auth/session'),
    logout: () => post<{ ok?: boolean }>('/auth/logout'),
    reauthenticatePassword: (password: string) =>
      post<{ stepUpExpiresAt: string }>('/auth/reauthenticate', { password }),
    sessions: () => get<SessionRow[]>('/auth/sessions'),
    revokeSession: (sessionId: string) => del<{ ok?: boolean }>(`/auth/sessions/${sessionId}`),
  },

  bootstrap: {
    claim: (claimCode: string) =>
      post<{ claimToken: string; expiresAt: string }>('/bootstrap/claim', { claimCode }),
    owner: (
      claimToken: string,
      input: { email: string; password: string; mfaType: 'totp' },
    ) =>
      post<{ ownerId: string; mfaEnrollmentSecret: string; otpauthUrl?: string; recoveryCodes: string[] }>(
        '/bootstrap/owner',
        input,
        { 'X-Claim-Token': claimToken },
      ),
    mfaVerify: (claimToken: string, code: string) =>
      post<{ ok?: boolean }>(
        '/bootstrap/mfa/verify',
        { code },
        { 'X-Claim-Token': claimToken },
      ),
  },

  overview: {
    get: () => get<OverviewData>('/overview'),
    serverInfo: () => get<ServerInfo>('/server/info'),
  },

  projects: {
    list: () => get<ProjectSummary[]>('/projects'),
    get: (projectId: string) =>
      get<ProjectSummary & { services?: ServiceDetail[] }>(`/projects/${projectId}`),
    create: (name: string) => post<ProjectSummary>('/projects', { name }),
  },

  services: {
    get: (serviceId: string) => get<ServiceDetail>(`/services/${serviceId}`),
    createFromZip: (
      projectId: string,
      input: { name: string; role: string; uploadId: string; framework?: string },
    ) =>
      post<{ serviceId: string; deploymentId: string }>(`/projects/${projectId}/services`, {
        source: 'zip',
        ...input,
      }),
    createFromGithub: (
      projectId: string,
      input: { name: string; role: string; repoFullName: string; branch: string },
    ) =>
      post<{ serviceId: string; deploymentId: string }>(`/projects/${projectId}/services`, {
        source: 'github',
        ...input,
      }),
    variables: {
      list: (serviceId: string) =>
        get<{ items: ServiceVariable[] }>(`/services/${serviceId}/variables`),
      set: (serviceId: string, key: string, value: string) =>
        post<{ key: string }>(`/services/${serviceId}/variables`, { key, value }),
      remove: (serviceId: string, key: string) =>
        del<{ key: string }>(`/services/${serviceId}/variables/${key}`),
    },
  },

  deployments: {
    list: (serviceId: string) =>
      get<{ items: DeploymentSummary[] }>(`/services/${serviceId}/deployments`),
    events: (serviceId: string, deploymentId: string) =>
      get<{ items: DeploymentEvent[] }>(
        `/services/${serviceId}/deployments/${deploymentId}/events`,
      ),
    redeploy: (serviceId: string) =>
      post<{ serviceId: string; deploymentId: string }>(`/services/${serviceId}/deployments`),
    rollback: (serviceId: string, deploymentId: string) =>
      post<{ operationId: string }>(`/services/${serviceId}/rollbacks`, { deploymentId }),
  },

  serviceFiles: {
    list: (serviceId: string, path = '', search?: string) =>
      get<{ path: string; items: FileEntry[]; query?: string; truncated?: boolean }>(
        `/services/${serviceId}/files${
          search && search.trim()
            ? `?search=${encodeURIComponent(search)}`
            : path
              ? `?path=${encodeURIComponent(path)}`
              : ''
        }`,
      ),
    read: (serviceId: string, path: string) =>
      get<{ path: string; size: number; modified: string; content: string }>(
        `/services/${serviceId}/files/content?path=${encodeURIComponent(path)}`,
      ),
    save: (serviceId: string, path: string, content: string) =>
      put<{ path: string; size: number }>(`/services/${serviceId}/files/content`, { path, content }),
    upload: async (serviceId: string, path: string, file: File): Promise<{ path: string; size: number }> => {
      const res = await fetch(
        `${BASE}/services/${serviceId}/files/upload?path=${encodeURIComponent(path)}`,
        { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
      );
      if (!res.ok) {
        let payload: Record<string, unknown> = {};
        try { payload = await res.json(); } catch { /* empty body */ }
        throw new ApiError(res.status, (payload.error ?? payload) as never);
      }
      return (await res.json()) as { path: string; size: number };
    },
    mkdir: (serviceId: string, path: string) =>
      post<{ path: string }>(`/services/${serviceId}/files/mkdir`, { path }),
    remove: (serviceId: string, path: string) =>
      del<{ removed: string }>(
        `/services/${serviceId}/files?path=${encodeURIComponent(path)}`,
      ),
    extract: (serviceId: string, uploadId: string, path = '') =>
      post<{ extractedInto: string; entryCount: number }>(`/services/${serviceId}/files/extract`, {
        uploadId,
        path,
      }),
    redeployZip: (serviceId: string, uploadId: string) =>
      post<{ serviceId: string; deploymentId: string }>(`/services/${serviceId}/files/redeploy-zip`, {
        uploadId,
      }),
    restart: (serviceId: string) =>
      post<{ container: string; state: string }>(`/services/${serviceId}/restart`),
    rename: (serviceId: string, from: string, to: string) =>
      post<{ from: string; to: string }>(`/services/${serviceId}/files/rename`, { from, to }),
    copy: (serviceId: string, from: string, to: string) =>
      post<{ from: string; to: string }>(`/services/${serviceId}/files/copy`, { from, to }),
    usage: (serviceId: string) =>
      get<{ bytes: number; files: number; dirs: number; recent: FileEntry[] }>(
        `/services/${serviceId}/files/usage`,
      ),
  },

  uploads: {
    init: (filename: string, size: number, mimeType: string) =>
      post<{ uploadId: string; uploadUrl: string; expiresAt: string }>('/uploads/init', {
        filename,
        size,
        mimeType,
      }),
    receive: async (uploadUrl: string, file: File, sha256: string): Promise<void> => {
      const form = new FormData();
      form.append('file', file, file.name);
      const sep = uploadUrl.includes('?') ? '&' : '?';
      const res = await fetch(`${BASE}${uploadUrl}${sep}sha256=${encodeURIComponent(sha256)}`, {
        method: 'PUT',
        credentials: 'include',
        body: form,
      });
      if (!res.ok) {
        let payload: Record<string, unknown> = {};
        try {
          payload = await res.json();
        } catch {
          /* ignore */
        }
        throw new ApiError(res.status, (payload.error ?? payload) as never);
      }
    },
    finalize: (uploadId: string, sha256: string) =>
      post<{ uploadId: string; validated: boolean; detectedFramework: string; entryCount: number }>(
        `/uploads/${uploadId}/finalize`,
        { sha256 },
      ),
  },

  domains: {
    list: () => get<{ items: DomainInfo[] }>('/domains'),
    add: (host: string) => post<DomainInfo>('/domains', { host }),
    get: (domainId: string) => get<DomainInfo>(`/domains/${domainId}`),
    verify: (domainId: string) => post<DomainInfo>(`/domains/${domainId}/verify`),
    setDnsMode: (domainId: string, mode: 'MANUAL' | 'MANAGED') =>
      post<DomainInfo>(`/domains/${domainId}/dns-mode`, { mode }),
    remove: (domainId: string) => del<{ id: string }>(`/domains/${domainId}`),
  },

  audit: {
    list: (opts: { cursor?: string; limit?: number; resourceType?: string } = {}) => {
      const q = new URLSearchParams();
      if (opts.cursor) q.set('cursor', opts.cursor);
      if (opts.limit) q.set('limit', String(opts.limit));
      if (opts.resourceType) q.set('resourceType', opts.resourceType);
      const qs = q.toString();
      return get<{ items: AuditEventInfo[]; nextCursor: string | null }>(
        `/audit-events${qs ? `?${qs}` : ''}`,
      );
    },
  },
};

/** Compute SHA-256 (hex) of a file in the browser. */
export async function fileSha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
