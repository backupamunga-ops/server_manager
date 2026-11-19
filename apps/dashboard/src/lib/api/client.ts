/**
 * API client for the Cloudlane dashboard.
 */

import type {
  ClaimResponse,
  InstallationStatusResponse,
  LoginResponse,
  OwnerCreationResponse,
  ProjectDetail,
  ProjectSummary,
  SessionInfo,
} from '@cloudlane/contracts';

const BASE = '/api/v1';

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  return h;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: headers(init.headers as Record<string, string>),
  });

  const newCsrf = res.headers.get('X-CSRF-Token');
  if (newCsrf) setCsrfToken(newCsrf);

  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: { code: 'NETWORK_ERROR', message: res.statusText } }));
    throw body;
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  installation: {
    status: () => request<InstallationStatusResponse>('/installation/status'),
  },
  bootstrap: {
    claim: (claimCode: string) =>
      request<ClaimResponse>('/bootstrap/claim', {
        method: 'POST',
        body: JSON.stringify({ claimCode }),
      }),
    createOwner: (
      input: { email: string; password: string; workspaceName: string; mfaType: 'totp' },
      claimToken: string,
    ) =>
      request<OwnerCreationResponse>('/bootstrap/owner', {
        method: 'POST',
        headers: { 'X-Claim-Token': claimToken },
        body: JSON.stringify(input),
      }),
    verifyMfa: (factorId: string, code: string) =>
      request<{ userId: string; sessionId: string }>('/bootstrap/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ factorId, code }),
      }),
  },
  auth: {
    login: (email: string, password: string) =>
      request<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    verifyMfa: (mfaChallengeId: string, code: string) =>
      request<{ userId: string; sessionId: string }>('/auth/mfa/verify', {
        method: 'POST',
        body: JSON.stringify({ mfaChallengeId, code }),
      }),
    session: () => request<SessionInfo>('/auth/session'),
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  },
  projects: {
    list: () => request<{ items: ProjectSummary[] }>('/projects'),
    get: (id: string) => request<ProjectDetail>(`/projects/${id}`),
    create: (name: string, slug?: string) =>
      request<{ id: string; name: string; slug: string }>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      }),
    delete: (id: string) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),
  },
};
