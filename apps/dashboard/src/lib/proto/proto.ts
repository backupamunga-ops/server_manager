/* Cloudlane panel — faithful port of Interactive Prototype v1.13.
 * Assembled from four fragments (core / views / modals / actions) into one
 * module scope so every template literal, class and interaction matches the
 * prototype exactly. Data comes from the real workspace API (build plan §4);
 * the prototype's local-only simulations remain only where no pipeline exists
 * yet (marked SIMULATED), and agents upgrade them end-to-end. */
'use strict';

import { api, ApiError } from '$api/client';

const NOW = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

/* ── CloudlaneState — exact shape served by GET /api/v1/workspace ── */
interface Variable { key: string; value: string }
interface ServiceRec {
  id: string; projectId: string; name: string; kind: string; env: string; status: string;
  created: string; activeDeployment: string | null;
  role?: string; framework?: string; source?: string; repo?: string; branch?: string;
  autoDeploy?: boolean; fileName?: string; variables?: Variable[];
  engine?: string; version?: string; database?: string; external?: boolean;
  allowedIp?: string; password?: string; backups?: { id: string; created: string; status: string }[];
  method?: string; target?: string; schedule?: string; timezone?: string; enabled?: boolean;
  provider?: string; region?: string;
}
interface DeploymentRec {
  id: string; serviceId: string; status: string; stage: number; created: string;
  finished: string | null; revision: string; logs: { msg: string; level: string }[];
  failAt?: string | null; simulating?: boolean;
}
interface DomainRec {
  id: string; name: string; status: string; https: boolean; created: string;
  type: string; serviceId?: string; hostnameId?: string;
}
interface ZoneRec { id: string; name: string; status: string; dnsMode: string; created: string; pendingDnsMode?: string; delegation?: string }
interface HostnameRec { id: string; name: string; zoneId: string; type: string; serviceId: string | null; created: string }
interface RecordRec { id: string; zoneId: string; type: string; name: string; value: string; ttl: number; priority?: number }
interface MailboxRec { id: string; zoneId: string; local: string; quota: number; created: string; status: string }
interface AliasRec { id: string; zoneId: string; local: string; target: string; created: string }
interface DbUserRec { id: string; serviceId: string; username: string; privileges: string[]; revoked: boolean; created: string; password: string }
interface CronRunRec { id: string; serviceId: string; status: string; created: string; duration?: string; code?: string }
interface ActivityRec { id: string; title: string; detail?: string; type: string; created: string }
interface ApiKeyRec { id: string; name: string; scope: string; last4: string; created: string; revoked: boolean }
interface LinkRec { id: string; from: string; to: string; created: string }
interface BucketRec { id: string; storageId: string; name: string; privacy: string; purpose?: string; maxMB: number; created: string }
interface ObjectRec { id: string; bucketId: string; key: string; size: number; type: string; isFolder?: boolean; created: string }
interface GrantRec { id: string; storageId: string; bucketId: string; serviceId: string; scope: string; created: string }
interface VolumeRec { id: string; serviceId: string; name: string; mount: string; quotaMB: number; created: string }
interface CloudlaneState {
  version: number;
  workspace: string;
  githubConnected: boolean;
  server: { id: string; name: string; os: string; cpu: number; ram: number; disk: number; healthy: boolean };
  projects: { id: string; name: string; slug: string; created: string }[];
  services: ServiceRec[];
  deployments: DeploymentRec[];
  domains: DomainRec[];
  domainZones: ZoneRec[];
  hostnames: HostnameRec[];
  dnsRecords: RecordRec[];
  mailboxes: MailboxRec[];
  mailAliases: AliasRec[];
  dbUsers: DbUserRec[];
  cronRuns: CronRunRec[];
  activities: ActivityRec[];
  apiKeys: ApiKeyRec[];
  serviceLinks: LinkRec[];
  buckets: BucketRec[];
  objects: ObjectRec[];
  storageGrants: GrantRec[];
  volumes: VolumeRec[];
}

/* Empty shell until the first aggregate arrives; render() is gated on loaded. */
let state: CloudlaneState = {
  version: 1, workspace: 'Workspace', githubConnected: false,
  server: { id: 'srv_main', name: 'primary-vps', os: 'Ubuntu 24.04 LTS', cpu: 1, ram: 1024, disk: 10, healthy: true },
  projects: [], services: [], deployments: [], domains: [], domainZones: [], hostnames: [],
  dnsRecords: [], mailboxes: [], mailAliases: [], dbUsers: [], cronRuns: [], activities: [],
  apiKeys: [], serviceLinks: [], buckets: [], objects: [], storageGrants: [], volumes: [],
};
let loaded = false;

/* Deep-link routing — real URLs map onto the prototype's page state. */
function parsePath(path: string): { page: string; pId: string | null; sId: string | null; tab: string | null } {
  const seg = path.replace(/^\/+|\/+$/g, '').split('/');
  const q = new URLSearchParams(window.location.search);
  const tab = q.get('tab');
  if (seg.length === 1) {
    const map: Record<string, string> = { storage: 'storageIndex', databases: 'databases', cron: 'cron' };
    const page = map[seg[0]] ?? seg[0];
    return { page, pId: null, sId: null, tab: tab ?? (seg[0] === 'settings' ? 'workspace' : 'overview') };
  }
  if (seg[0] === 'projects' && seg[1]) return { page: 'project', pId: seg[1], sId: null, tab: tab ?? null };
  if (seg[0] === 'services' && seg[1]) return { page: 'service', pId: null, sId: seg[1], tab: tab ?? 'overview' };
  if (seg[0] === 'domains' && seg[1]) return { page: 'domainDetail', pId: seg[1], sId: null, tab: tab ?? 'overview' };
  return { page: 'overview', pId: null, sId: null, tab: 'overview' };
}
function buildPath(page: string, pId: string | null, sId: string | null, tab: string | null): string {
  const inv: Record<string, string> = { storageIndex: 'storage', databases: 'databases', cron: 'cron' };
  const seg = inv[page] ?? page;
  if (page === 'project' && pId) return `/projects/${pId}`;
  if (page === 'service' && sId) return `/services/${sId}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`;
  if (page === 'domainDetail' && pId) return `/domains/${pId}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`;
  if (page === 'settings' && tab && tab !== 'workspace') return `/settings?tab=${tab}`;
  return `/${seg}`;
}

let ui: Record<string, unknown> = {
  page: 'overview', projectId: null, serviceId: null, tab: 'overview',
  projectTab: 'services', settingsTab: 'workspace', domainZoneId: null,
  modal: null, modalData: {} as Record<string, unknown>, mobileMenu: false, toast: null as null | { message: string; error: boolean },
  search: '', showPassword: false,
  assistantOpen: false, assistantText: '', assistantPlan: null as null | { prompt: string; summary: string; steps: string[]; progress: number; approved: boolean; complete: boolean },
  revealedKey: null as string | null,
  termRole: 'developer', termSession: null as null | { serviceId: string; startedAt: number; expiresAt: number; entries: { kind: string; text: string }[] },
  sqlDraft: '', sqlResult: null as null | { serviceId: string; blocked: boolean; columns: string[]; rows: unknown[][]; message: string },
  storageBucketId: null as string | null, storagePrefix: '', storageSearch: '',
};

/* Server sync — mutations go through runAction / real endpoints. */
async function syncState(): Promise<void> {
  try {
    state = await api.get<CloudlaneState>('/workspace');
    loaded = true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { window.location.href = '/login'; return; }
    loaded = true;
  }
}
/** Dispatch a prototype mutation; the server returns a fresh aggregate. */
async function apply(type: string, payload: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const res = await api.post<{ generatedKey?: string } & CloudlaneState>('/workspace/actions', { type, payload });
    if (res.generatedKey !== undefined) ui.revealedKey = res.generatedKey;
    const { generatedKey, ...next } = res;
    void generatedKey;
    state = next as CloudlaneState;
    return true;
  } catch (err) {
    flash(err instanceof ApiError ? err.message : 'The operation failed. Please try again.', true);
    return false;
  }
}

/* ── icons — verbatim from the prototype ── */
const iconPaths: Record<string, string> = {
  cloud: '<path d="M20 16.6A4.4 4.4 0 0 0 18 8.3 6.5 6.5 0 0 0 5.6 10a4 4 0 0 0 1 7.9H18a4.2 4.2 0 0 0 2-1.3Z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
  server: '<rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  pulse: '<path d="M2 12h4l3-7 5 14 3-7h5"/>',
  settings: '<path d="M12 3a3 3 0 0 0-2.8 1.9L7 4 5 6l.9 2.2A3 3 0 0 0 4 11v2a3 3 0 0 0 1.9 2.8L5 18l2 2 2.2-.9A3 3 0 0 0 11 21h2a3 3 0 0 0 2.8-1.9L18 20l2-2-.9-2.2A3 3 0 0 0 21 13v-2a3 3 0 0 0-1.9-2.8L20 6l-2-2-2.2.9A3 3 0 0 0 13 3h-1Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  check: '<path d="m4 12 5 5 11-11"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v4h18v-4"/>',
  github: '<path d="M9 19c-5 2-5-2-7-2m15 4v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.1-1.5 6.1-6.7a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.2-.4-3.7 1.4a12.8 12.8 0 0 0-6.7 0C7.8.2 6.6.6 6.6.6a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 5 7.8c0 5.2 3.1 6.4 6.1 6.7a3.4 3.4 0 0 0-.9 2.6V21" transform="translate(1 1) scale(.9)"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
  code: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-12-2 16"/>',
  terminal: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="m6 9 3 3-3 3m6 0h5"/>',
  rocket: '<path d="M7 17c-3 0-4 1-4 4 3 0 4-1 4-4Zm1-2 1 1 7-7c3-3 4-6 4-7-1 0-4 1-7 4L6 13l2 2ZM12 8l4 4M5 15l-2-2 4-4 3 1m4 4 1 3-4 4-2-2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  shield: '<path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6Z"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v5M12 7h.01"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v4m0 4h.01"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a8 8 0 0 1 14-2l1 5M4 12l1 5a8 8 0 0 0 14-2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  zap: '<path d="m13 2-9 12h7l-1 8 10-12h-7Z"/>',
  external: '<path d="M12 4h8v8M20 4l-9 9M20 14v6H4V4h6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 0h3v3m-6 0h3v3"/>',
  chart: '<path d="M4 20V9m6 11V4m6 16v-7m5 7H2"/>',
  history: '<path d="M3 12a9 9 0 1 0 2-6m-2-3v5h5M12 7v5l3 2"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 6v12M18 8a6 6 0 0 1-6 6H6"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 9 9 5 9-5M12 14v7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .6l3-3a5 5 0 0 0-7-7l-2 2m3 5a5 5 0 0 0-7-.6l-3 3a5 5 0 0 0 7 7l2-2"/>',
  trash: '<path d="M3 6h18m-2 0-1 15H6L5 6m3 0V3h8v3M10 10v7m4-7v7"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3 21 21M10 5.2c.7-.1 1.4-.2 2-.2 6 0 10 7 10 7a19 19 0 0 1-3.2 4.1M6 6.7A20 20 0 0 0 2 12s4 7 10 7a9 9 0 0 0 4-.9"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  logout: '<path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M14 7l5 5-5 5m5-5H8"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5"/>',
  file: '<path d="M6 2h9l5 5v15H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM14 2v6h6"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/>',
  harddrive: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 13h18M7 16h.01M11 16h.01"/>',
  pencil: '<path d="m4 20 5-.8L20 8a2.1 2.1 0 0 0-4-4L5 15l-1 5Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0"/>',
  sparkles: '<path d="m12 3 1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H4zM20 4h-7a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h7z"/>',
  connections: '<rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4m0 0 4-7m-4 7 4 7"/>',
  bucket: '<path d="M3 7c0-2 4-4 9-4s9 2 9 4-4 4-9 4-9-2-9-4Zm0 0v10c0 2 4 4 9 4s9-2 9-4V7M3 12c0 2 4 4 9 4s9-2 9-4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 17-5-5L5 21"/>',
  filelock: '<path d="M7 2h8l5 5v8M15 2v5h5M7 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h4"/><rect x="12" y="15" width="9" height="7" rx="1.5"/><path d="M14 15v-2a2.5 2.5 0 0 1 5 0v2"/>',
  folderopen: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3M3 6v13a2 2 0 0 0 2 2h12l5-9H8l-5 9"/>',
  disk: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v7h10V3M7 21v-8h10v8M10 6h4"/>'
};

function ico(name: string, size = 17, extra = ''): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${iconPaths[name] || iconPaths.box}</svg>`;
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
} as Record<string, string>)[c]);
const attr = esc;
const project = (id: unknown) => state.projects.find((p) => p.id === id);
const service = (id: unknown) => state.services.find((s) => s.id === id);
const deploymentsFor = (id: unknown) => state.deployments
  .filter((d) => d.serviceId === id)
  .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
const domainsFor = (id: unknown) => state.domains.filter((d) => d.serviceId === id);
const isVisualApp = (s: { kind: string; role: string; framework?: string }) =>
  s.kind === 'application' && (s.role === 'static' || s.role === 'web' || /static|html|front|site/i.test(s.framework || ''));
const primaryDomain = (id: unknown) => domainsFor(id).find((d) => d.type === 'custom' && (d.status === 'active' || d.status === 'VERIFIED'))?.name
  || domainsFor(id).find((d) => d.status === 'active' || d.status === 'VERIFIED')?.name || 'Not configured';
const age = (d?: string | null) => {
  if (!d) return '—';
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const date = (d?: string | null) => d ? new Date(d).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—';
const cap = (s: unknown) => String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const btn = (label: string, act: string, variant = '', extra = '') =>
  `<button class="btn ${variant}" data-action="${act}" ${extra}>${label}</button>`;
const badge = (name: unknown, kind = '') => `<span class="tag ${kind}">${esc(name)}</span>`;
const statusBadge = (s?: string) => {
  const val = String(s || 'unknown').toLowerCase();
  const type = ['live', 'running', 'active', 'success', 'ready', 'verified', 'connected', 'available'].includes(val) ? 'ok'
    : ['failed', 'error', 'offline'].includes(val) ? 'fail'
    : ['building', 'starting', 'queued', 'fetching', 'validating', 'detecting', 'health_checking', 'activating', 'running job', 'deploying'].includes(val) ? 'blue'
    : 'warn';
  return `<span class="tag ${type}"><span class="dot" style="width:5px;height:5px;background:currentColor;box-shadow:none"></span>${esc(cap(val))}</span>`;
};
const itemIcon = (s: ServiceRec) => s.kind === 'database' ? 'database' : s.kind === 'cron' ? 'clock'
  : s.role === 'api' ? 'code' : s.role === 'worker' ? 'terminal' : 'globe';

function activity(title: string, detail: string, type = 'system'): void {
  state.activities.unshift({ id: uid('act'), title, detail, type, created: NOW() });
  state.activities = state.activities.slice(0, 80);
}

function flash(message: string, error = false): void {
  ui.toast = { message, error };
  renderToast();
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { ui.toast = null; renderToast(); }, 4400);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(flash as any).timer = undefined as any;

function renderToast(): void {
  const old = document.getElementById('toast');
  if (old) old.remove();
  if (ui.toast) {
    const el = document.createElement('div');
    el.id = 'toast';
    el.className = `toast${ui.toast.error ? ' error-toast' : ''}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `${ico(ui.toast.error ? 'alert' : 'check', 18)}<span>${esc(ui.toast.message)}</span><button aria-label="Dismiss" data-action="dismissToast">${ico('close', 15)}</button>`;
    document.body.appendChild(el);
  }
}

function go(page: string, pId: string | null = null, sId: string | null = null, tab: string | null = 'overview'): void {
  ui.page = page;
  ui.projectId = page === 'domainDetail' ? null : pId;
  ui.domainZoneId = page === 'domainDetail' ? pId : null;
  ui.serviceId = sId;
  ui.tab = tab ?? 'overview';
  if (page === 'settings') ui.settingsTab = 'workspace';
  if (page === 'project') ui.projectTab = 'services';
  ui.modal = null;
  ui.mobileMenu = false;
  ui.search = '';
  render();
  const path = buildPath(page, pId, sId, tab);
  window.history.pushState({}, '', path);
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
}

/* Appearance (v1.10) — palette + mode, local preference. */
const CLOUDLANE_APPEARANCE_KEY = 'cloudlane-appearance-v110';
const CLOUDLANE_PALETTES: [string, string][] = [
  ['original', 'Original · Teal / Slate'],
  ['slate', 'Slate & Charcoal'],
  ['sand', 'Sand & Saddle'],
  ['sage', 'Sage & Burgundy'],
  ['mauve', 'Mauve Meadow']
];
function readCloudlaneAppearance(): { palette: string; mode: string } {
  try {
    const x = JSON.parse(localStorage.getItem(CLOUDLANE_APPEARANCE_KEY) || '{}');
    return {
      palette: CLOUDLANE_PALETTES.some((p) => p[0] === x.palette) ? x.palette : 'original',
      mode: x.mode === 'light' ? 'light' : 'dark',
    };
  } catch (_) {
    return { palette: 'original', mode: 'dark' };
  }
}
let cloudlaneAppearance = readCloudlaneAppearance();
function applyCloudlaneAppearance(): void {
  document.documentElement.dataset.palette = cloudlaneAppearance.palette;
  document.documentElement.classList.toggle('dark', cloudlaneAppearance.mode === 'dark');
  document.documentElement.style.colorScheme = cloudlaneAppearance.mode;
}
function chooseCloudlaneAppearance(patch: { palette?: string; mode?: string }): void {
  cloudlaneAppearance = { ...cloudlaneAppearance, ...patch };
  try { localStorage.setItem(CLOUDLANE_APPEARANCE_KEY, JSON.stringify(cloudlaneAppearance)); } catch (_) {}
  applyCloudlaneAppearance();
  render();
}
function appearancePanel(): string {
  return `<section class="card design-pref-panel" aria-label="Appearance preferences"><div class="design-pref-header"><div><h3 class="section-title">Appearance</h3><p class="design-intro">Colors, typography, and control styling follow the uploaded design system. Cloudlane workflows remain unchanged.</p></div>${badge('Visual preference', 'blue')}</div><div class="design-pref-group">Appearance mode</div><div class="design-mode-group" role="group" aria-label="Color mode">${[['light', 'Light'], ['dark', 'Dark']].map(([mode, label]) => `<button type="button" data-action="designMode" data-mode="${mode}" aria-pressed="${cloudlaneAppearance.mode === mode}">${label}</button>`).join('')}</div><div class="design-pref-group">Color palette</div><div class="design-palette-grid" role="group" aria-label="Color palette">${CLOUDLANE_PALETTES.map(([id, label]) => `<button type="button" class="design-palette-choice" data-action="designPalette" data-palette="${id}" aria-pressed="${cloudlaneAppearance.palette === id}"><span class="design-swatch ${id}" aria-hidden="true"></span><strong>${label}</strong></button>`).join('')}</div><p class="hint" style="margin-top:15px">This setting changes only how your Cloudlane panel looks. It does not affect projects, deployments, or DNS.</p></section>`;
}
/* ── views — template literals copied verbatim from the prototype (final layer) ── */

const navGroupsV15 = [{
  label: 'WORKSPACE',
  items: [
    ['overview', 'layout', 'Overview'],
    ['projects', 'folder', 'Projects']
  ]
}, {
  label: 'RESOURCES',
  items: [
    ['domains', 'globe', 'Domains'],
    ['databases', 'database', 'Databases'],
    ['email', 'mail', 'Email'],
    ['cron', 'clock', 'Cron Jobs']
  ]
}, {
  label: 'INFRASTRUCTURE',
  items: [
    ['activity', 'pulse', 'Activity & Logs'],
    ['servers', 'server', 'Server']
  ]
}, {
  label: 'PREFERENCES',
  items: [
    ['settings', 'settings', 'Settings']
  ]
}];

function sidebar(): string {
  return `<aside class="sidebar ${ui.mobileMenu ? 'open' : ''}"><div class="brand"><div class="logo">${ico('layers', 22)}</div><div><div class="brand-name">cloudlane<span style="color:var(--mint)">.</span></div><div class="brand-tag">INFRASTRUCTURE, SIMPLIFIED</div></div></div><nav class="nav-list" aria-label="Main navigation">${navGroupsV15.map((group) => `<div class="nav-group-title">${group.label}</div>${group.items.map(([id, ic, t]) => `<button class="nav-item ${ui.page === id || ((ui.page === 'project' || ui.page === 'service') && id === 'projects') || (ui.page === 'domainDetail' && id === 'domains') ? 'active' : ''}" data-action="go" data-page="${id}">${ico(ic, 16)}<span>${t}</span></button>`).join('')}`).join('')}</nav><div class="sidebar-bottom"><button class="side-small-link" data-action="openDocs">${ico('book', 15)} Documentation ${ico('external', 13)}</button><div class="tiny-profile" style="margin-top:10px"><div class="avatar">${esc(initials())}</div><div><div class="profile-name">${esc(state.workspace)}</div><div class="profile-meta">Cloudlane workspace</div></div></div></div></aside>`;
}
const initials = () => (state.workspace || 'CW').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'CW';

function header(): string {
  const title = ({
    overview: 'Overview', projects: 'Projects', servers: 'Server', databases: 'Databases',
    cron: 'Cron Jobs', domains: 'Domains', email: 'Email', activity: 'Activity & Logs',
    settings: 'Settings', storageIndex: 'Object Storage', docs: 'Documentation',
    project: project(ui.projectId)?.name || 'Project',
    service: service(ui.serviceId)?.name || 'Service',
    domainDetail: domainZone(ui.domainZoneId)?.name || 'Domain',
  } as Record<string, string>)[ui.page as string] || 'Overview';
  const p = ui.page === 'service' ? project(service(ui.serviceId)?.projectId) : null;
  const inDomain = ui.page === 'domainDetail';
  return `<header class="topbar"><button class="icon-btn mobile-toggle" data-action="mobileMenu" aria-label="Open menu">${ico('menu', 19)}</button><div class="crumb"><span>Workspace</span>${ico('chevron', 12)}${inDomain ? `<button class="link" data-action="go" data-page="domains">Domains</button>${ico('chevron', 12)}` : ''}${p ? `<button class="link" data-action="openProject" data-id="${p.id}">${esc(p.name)}</button>${ico('chevron', 12)}` : ''}<strong>${esc(title)}</strong></div><div class="top-spacer"></div><span class="top-server"><span class="dot"></span> VPS connected</span><span class="top-pill">${ico('alert', 13)} v1.13</span></header>`;
}

function heading(label: string, title: string, sub: string, actions = ''): string {
  return `<div class="heading"><div><p class="eyebrow">${esc(label)}</p><h1>${esc(title)}</h1><p class="subtitle">${esc(sub)}</p></div><div class="head-actions">${actions}</div></div>`;
}

function statsCard(ic: string, num: string | number, label: string, foot: string): string {
  return `<div class="card stat"><div class="stat-row"><div class="stat-icon">${ico(ic, 18)}</div><div class="stat-main"><div class="stat-label">${esc(label)}</div><div class="stat-note">${esc(foot)}</div></div><div class="stat-number">${esc(num)}</div></div></div>`;
}

function projectCard(p: { id: string; name: string; created: string }): string {
  const ss = state.services.filter((s) => s.projectId === p.id);
  const online = ss.filter((s) => ['running', 'active', 'ready'].includes(s.status)).length;
  return `<div class="card project-card clickable" data-action="openProject" data-id="${p.id}" role="button" tabindex="0" aria-label="Open ${attr(p.name)} project"><span class="project-mark">${ico('folder', 18)}</span><div class="project-copy"><h3>${esc(p.name)}</h3><div class="project-desc">${ss.length} service${ss.length === 1 ? '' : 's'} <span class="project-meta-separator">·</span> <span class="project-health"><span class="project-health-dot ${online ? 'is-healthy' : ''}"></span>${online} healthy</span></div></div><div class="project-tail"><span class="project-env">production</span><span class="project-age">${esc(age(p.created))}</span></div><span class="project-open" aria-hidden="true">${ico('arrow', 15)}</span></div>`;
}

function activityMarkup(items: ActivityRec[]): string {
  return `<div class="activity-list">${items.length ? items.map((a) => `<div class="activity-item"><span class="activity-icon">${ico(({ deploy: 'rocket', database: 'database', cron: 'clock', domain: 'globe', project: 'folder', system: 'settings' } as Record<string, string>)[a.type] || 'pulse', 15)}</span><div class="activity-body"><span class="activity-text">${esc(a.title)}</span><span class="activity-detail">${esc(a.detail)}</span><span class="activity-time">${esc(age(a.created))}</span></div></div>`).join('') : '<p class="muted small">No activity yet.</p>'}</div>`;
}

function healthBlock(): string {
  const vals: [string, number, string][] = [
    ['CPU usage', 23, '0.23 / 1 vCPU'],
    ['Memory usage', 51, '522 MB / 1,024 MB'],
    ['Disk usage', 46, '4.6 GB / 10 GB']
  ];
  return `<div class="metrics">${vals.map(([n, v, t]) => `<div class="metric"><div class="metric-label"><span class="muted">${n}</span><span class="metric-value">${v}%</span></div><div class="progress"><span style="width:${v}%"></span></div><div class="hint">${t} · simulated</div></div>`).join('')}</div>`;
}

function overview(): string {
  const active = state.services.filter((s) => s.kind === 'application' && s.status === 'running').length;
  const db = state.services.filter((s) => s.kind === 'database').length;
  const jobs = state.services.filter((s) => s.kind === 'cron').length;
  return `${heading('YOUR INFRASTRUCTURE', 'Good morning, builder.', 'Everything you need to deploy, run and manage your services, in one place.', btn(`${ico('plus', 16)} Create new`, 'new', 'btn-primary'))}<div class="grid four">${statsCard('folder', state.projects.length, 'Projects', 'Organized workspaces')}${statsCard('rocket', active, 'Live applications', 'Across all projects')}${statsCard('database', db, 'Databases', 'Provisioned services')}${statsCard('clock', jobs, 'Scheduled jobs', 'Independent workflows')}</div><div class="section-head"><h2 class="section-title">Quick actions</h2></div><div class="grid three"><button class="quicklink" data-action="openModal" data-modal="deploy"><span class="status-icon mint">${ico('rocket', 19)}</span><span><div class="q-name">Deploy an application</div><div class="q-desc">From ZIP or GitHub</div></span><span style="margin-left:auto;color:var(--muted)">${ico('chevron', 15)}</span></button><button class="quicklink" data-action="openModal" data-modal="database"><span class="status-icon">${ico('database', 19)}</span><span><div class="q-name">Create database</div><div class="q-desc">PostgreSQL, MySQL, MariaDB</div></span><span style="margin-left:auto;color:var(--muted)">${ico('chevron', 15)}</span></button><button class="quicklink" data-action="openModal" data-modal="cron"><span class="status-icon gold">${ico('clock', 19)}</span><span><div class="q-name">Schedule a cron job</div><div class="q-desc">HTTP callbacks or tasks</div></span><span style="margin-left:auto;color:var(--muted)">${ico('chevron', 15)}</span></button></div><div class="card" style="margin-top:16px"><div class="row space" style="flex-wrap:wrap;gap:12px"><div class="row"><span class="status-icon gold">${ico('bucket', 19)}</span><div><strong class="small">Object storage &amp; media</strong><p class="muted xs">Private KYC documents, profile photos, and managed buckets—never VPS system files.</p></div></div>${btn('Explore storage →', 'storageIndex', 'btn-small')}</div></div><div class="section-head"><div><h2 class="section-title">Your projects</h2><div class="sub">A unified home for every service</div></div><button class="link" data-action="go" data-page="projects">View all ${ico('arrow', 14)}</button></div><div class="grid three">${state.projects.slice(0, 3).map(projectCard).join('')}${state.projects.length === 0 ? '<div class="card empty">No projects yet.</div>' : ''}</div><div class="section-head"><h2 class="section-title">Operations</h2></div><div class="grid two-wide"><div class="card"><div class="row space"><h3 class="section-title">Server health</h3>${badge('Healthy', 'ok')}</div><p class="muted small">${esc(state.server.name)} · ${esc(state.server.os)}</p>${healthBlock()}<div class="divider"></div><div class="row space"><span class="xs muted">Starter VPS budget</span><span class="xs strong">1 vCPU · 1 GB RAM · 10 GB disk</span></div><p class="hint" style="margin-top:9px">On a 1 GB VPS, build heavy projects off-server; avoid concurrent builds and databases.</p></div><div class="card"><div class="row space"><h3 class="section-title">Recent activity</h3><button class="link" data-action="go" data-page="activity">All activity</button></div>${activityMarkup(state.activities.slice(0, 4))}</div></div>`;
}

function projectsView(): string {
  const term = String(ui.search).toLowerCase().trim();
  const ps = state.projects.filter((p) => !term || p.name.toLowerCase().includes(term));
  return `${heading('WORKSPACE', 'Projects', 'Organize applications and infrastructure in environments.', btn(`${ico('plus', 15)} New project`, 'openModal', 'btn-primary', 'data-modal="project"'))}<div class="row space" style="margin-bottom:18px"><div class="search">${ico('search', 15)}<input id="projectSearch" placeholder="Search projects..." value="${attr(ui.search)}" aria-label="Search projects" /></div><div class="muted xs">${ps.length} project${ps.length !== 1 ? 's' : ''}</div></div><div id="projectResults" class="grid three">${ps.map(projectCard).join('') || '<div class="card empty"><h3>No projects found</h3><p>Create a project to get started.</p></div>'}</div>`;
}

function projectArchitecture(p: { id: string; name: string }, ss: ServiceRec[]): string {
  const apps = ss.filter((x) => x.kind === 'application');
  const dbs = ss.filter((x) => x.kind === 'database');
  const crons = ss.filter((x) => x.kind === 'cron');
  const connected = state.serviceLinks.filter((l) => ss.some((s) => s.id === l.from) && ss.some((s) => s.id === l.to));
  const suggestions: { from: ServiceRec; to: ServiceRec }[] = [];
  for (const a of apps)
    for (const d of dbs)
      if (!connected.some((l) => l.from === a.id && l.to === d.id)) suggestions.push({ from: a, to: d });
  const cards = ss.filter((s) => s.kind !== 'storage').map((s) => {
    const isApp = s.kind === 'application', isDb = s.kind === 'database';
    const meta = isApp ? `${s.framework} · ${cap(s.role)}` : isDb ? `${s.engine} · ${s.database}` : `${s.method} · ${s.schedule}`;
    const url = isApp ? `https://${primaryDomain(s.id)}` : isDb ? 'Private network by default' : 'Independent schedule';
    return `<article class="arch-node"><div class="row space"><div class="head"><span class="status-icon ${isDb ? 'gold' : s.kind === 'cron' ? 'purple' : 'mint'}">${ico(itemIcon(s), 17)}</span><strong>${esc(s.name)}</strong></div>${statusBadge(s.status)}</div><div class="muted xs">${esc(meta)}</div><div class="arch-url">${esc(url)}</div>${btn('Open service →', 'openService', 'btn-small', `data-id="${s.id}"`)}</article>`;
  }).join('');
  const domainLinks = apps.flatMap((s) => domainsFor(s.id).filter((d) => d.type === 'custom').map((d) =>
    `<div class="arch-link"><div class="label">${ico('globe', 15)}<span class="mono small">${esc(d.name)}</span>${ico('arrow', 12)}<strong class="small">${esc(s.name)}</strong></div>${badge('Domain binding', 'ok')}</div>`)).join('');
  const links = connected.map((l) => {
    const a = service(l.from), b = service(l.to);
    return a && b ? `<div class="arch-link"><div class="label">${ico('link', 15)}<strong class="small">${esc(a.name)}</strong>${ico('arrow', 14)}<strong class="small">${esc(b.name)}</strong></div><div class="row">${badge('Demo connection', 'ok')}${btn('Unlink', 'removeServiceLink', 'btn-small', `data-id="${l.id}"`)}</div></div>` : '';
  }).join('');
  const sugg = suggestions.map(({ from, to }) =>
    `<div class="arch-link"><div class="label">${ico('connections', 16)}<span class="small">${esc(from.name)} ${ico('arrow', 12)} ${esc(to.name)}</span></div><div class="row">${badge('Suggested, not connected', 'warn')}${btn('Connect (demo)', 'addServiceLink', 'btn-small', `data-from="${from.id}" data-to="${to.id}"`)}</div></div>`).join('');
  const stores = ss.filter((s) => s.kind === 'storage');
  const storeCards = stores.map((s) =>
    `<article class="arch-node"><div class="row space"><div class="head"><span class="status-icon gold">${ico('bucket', 18)}</span><strong>${esc(s.name)}</strong></div>${statusBadge(s.status)}</div><div class="muted xs">Object Storage · ${bucketsFor(s.id).length} private buckets</div><div class="arch-url">KYC documents · profile photos</div>${btn('Open storage →', 'openService', 'btn-small', `data-id="${s.id}"`)}</article>`).join('');
  const grantLinks = stores.flatMap((s) => grantsFor(s.id).map((g) => {
    const a = service(g.serviceId), b = bucket(g.bucketId);
    return `<div class="arch-link"><div class="label">${ico('link', 15)}<strong class="small">${esc(a?.name || 'Application')}</strong>${ico('arrow', 14)}<strong class="small">${esc(b?.name || 'Bucket')}</strong></div>${badge('Scoped storage grant · demo', 'ok')}</div>`;
  })).join('');
  const confirmed = connected.length + apps.flatMap((s) => domainsFor(s.id).filter((d) => d.type === 'custom')).length + stores.reduce((t, x) => t + grantsFor(x.id).length, 0);
  return `<div class="arch-map"><div class="soft-banner">${ico('connections', 21)}<div><strong class="small">Visual project architecture</strong><p>Understand what runs in this project and how services relate. Confirmed domain bindings are shown; same-project database links remain suggestions until you connect them.</p></div></div><div class="arch-head"><h2 class="section-title">Production services</h2><div class="arch-summary"><span class="arch-legend"><span class="dot"></span>${apps.length} applications</span><span class="arch-legend"><span class="dot gold"></span>${dbs.length} databases</span><span class="arch-legend"><span class="dot purple"></span>${crons.length} schedules</span></div></div><div class="arch-cards">${cards || '<div class="card empty">Add your first service to build the architecture map.</div>'}</div>${storeCards ? `<div class="section-head"><h3 class="section-title">Object storage</h3><span class="muted xs">${stores.length} managed service${stores.length > 1 ? 's' : ''}</span></div><div class="arch-cards">${storeCards}</div>` : ''}<div class="card"><div class="row space"><h3 class="section-title">Connections &amp; dependencies</h3>${badge(`${confirmed} confirmed (demo)`, 'blue')}</div><div class="divider"></div><div class="arch-links">${domainLinks}${links}${grantLinks}${sugg || (!domainLinks && !links ? '<p class="muted small">No relationships yet. Add an application, database, or custom domain.</p>' : '')}</div><p class="hint" style="margin-top:15px">A demo connection is a visual relationship only. In production, it would also configure scoped credentials, private networking, and secrets with approval.</p></div><div class="card"><div class="row space"><div><h3 class="section-title">Understand or troubleshoot this stack</h3><p class="muted xs">Ask for a safe diagnostic plan for any service in this project.</p></div>${btn(`${ico('sparkles', 15)} Ask assistant`, 'assistantOpen', 'btn-primary', `data-prompt="Check the health and dependencies of ${attr(p.name)}"`)}</div></div></div>`;
}

function projectView(): string {
  const p = project(ui.projectId);
  if (!p) return emptyMissing('Project');
  const ss = state.services.filter((s) => s.projectId === p.id);
  const stored = ss.filter((s) => s.kind === 'storage');
  const headerPart = `<button class="back" data-action="go" data-page="projects">${ico('back', 15)} All projects</button>${heading('PROJECT / PRODUCTION', p.name, `Created ${date(p.created)} · Default environment: production`, btn(`${ico('plus', 15)} Add service`, 'new', 'btn-primary', `data-project="${p.id}"`))}<div class="soft-banner">${ico('layers', 21)}<div><strong class="small">Production environment</strong><p>Services here share a project and can connect privately when supported.</p></div><div style="margin-left:auto">${badge(`${ss.length} services`, 'blue')}</div></div><div class="tabs project-tabs">${[['services', 'Services'], ['architecture', 'Architecture'], ['storage', 'Storage']].map(([k, t]) => `<button class="tab ${ui.projectTab === k ? 'active' : ''}" data-action="projectTab" data-tab="${k}">${t}</button>`).join('')}</div>`;
  if (ui.projectTab === 'architecture') return headerPart + projectArchitecture(p, ss);
  if (ui.projectTab === 'storage') return headerPart + storageBanner() +
    `<div class="row space" style="margin:20px 0 15px"><h2 class="section-title">Object storage</h2>${btn(`${ico('plus', 14)} Add storage`, 'openModal', 'btn-primary', `data-modal="storageCreate" data-project="${p.id}"`)}</div><div class="grid two">${stored.map((s) => `<div class="card"><div class="row space"><span class="status-icon mint">${ico('bucket', 19)}</span>${statusBadge(s.status)}</div><h3 style="margin:15px 0 6px">${esc(s.name)}</h3><p class="muted small">${bucketsFor(s.id).length} private buckets · ${bytesHuman(storageTotal(s.id))}</p><div class="divider"></div>${btn('Manage storage →', 'openService', '', `data-id="${s.id}"`)}</div>`).join('') || '<div class="card empty">No object storage in this project yet.</div>'}</div>`;
  return headerPart +
    `<div class="section-head"><h2 class="section-title">Services</h2>${stored.length ? btn('Browse storage →', 'projectTab', 'btn-small', 'data-tab="storage"') : ''}</div><div class="card table-frame cl-project-services"><div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Type</th><th>Status</th><th>Endpoint / connection</th><th>Actions</th></tr></thead><tbody>${ss.map((s) => {
      const type = s.kind === 'application' ? `${s.framework} · ${cap(s.role)}` : s.kind === 'database' ? s.engine : s.kind === 'storage' ? 'Object Storage' : 'Scheduled HTTP';
      const end = s.kind === 'application' ? primaryDomain(s.id) : s.kind === 'database' ? `${s.database} · internal` : s.kind === 'storage' ? `${bucketsFor(s.id).length} buckets · external provider` : s.schedule;
      return `<tr><td class="clickable-cell" data-action="openService" data-id="${s.id}"><div class="row"><span class="status-icon ${s.kind === 'database' || s.kind === 'storage' ? 'gold' : s.kind === 'cron' ? 'purple' : 'mint'}">${ico(s.kind === 'storage' ? 'bucket' : itemIcon(s), 16)}</span><div><div class="main-cell">${esc(s.name)}</div><div class="sub-cell">production</div></div></div></td><td>${esc(type)}</td><td>${statusBadge(s.status)}</td><td class="mono xs">${esc(end || '—')}</td><td>${btn('Manage', 'openService', 'btn-small', `data-id="${s.id}"`)}</td></tr>`;
    }).join('') || `<tr><td colspan="5"><div class="empty"><h3>No services yet</h3><p>Add an application, database, cron job, or object storage.</p>${btn('Add first service', 'new', 'btn-primary', `data-project="${p.id}"`)}</div></td></tr>`}</tbody></table></div></div>`;
}

function servicesIndex(kind: string): string {
  const list = state.services.filter((s) => s.kind === kind);
  const isDb = kind === 'database';
  const title = isDb ? 'Databases' : 'Cron Jobs';
  const desc = isDb ? 'Databases for your applications, wherever they run.' :
    'Schedule callbacks and background operations independently of apps.';
  return `${heading(isDb ? 'DATA LAYER' : 'AUTOMATION', title, desc, btn(`${ico('plus', 15)} Create ${isDb ? 'database' : 'cron job'}`, 'openModal', 'btn-primary', `data-modal="${isDb ? 'database' : 'cron'}"`))}<div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Project</th><th>${isDb ? 'Engine / database' : 'Schedule / target'}</th><th>Status</th><th>Manage</th></tr></thead><tbody>${list.map((s) => `<tr><td><div class="row"><span class="status-icon ${isDb ? 'gold' : 'purple'}">${ico(itemIcon(s), 16)}</span><div><div class="main-cell">${esc(s.name)}</div><div class="sub-cell">${isDb ? esc(s.external ? 'Restricted external access' : 'Private network') : esc(s.timezone)}</div></div></div></td><td>${esc(project(s.projectId)?.name || '—')}</td><td><div class="main-cell">${esc(isDb ? s.engine : s.schedule)}</div><div class="sub-cell">${esc(isDb ? s.database : s.target)}</div></td><td>${statusBadge(s.status)}</td><td><button class="btn btn-small" data-action="openService" data-id="${s.id}">Open ${ico('chevron', 13)}</button></td></tr>`).join('') || `<tr><td colspan="5"><div class="empty">${ico(isDb ? 'database' : 'clock', 28)}<h3>No ${isDb ? 'databases' : 'cron jobs'} yet</h3><p>Use Create New to provision your first service.</p></div></td></tr>`}</tbody></table></div></div>`;
}

const domainZone = (id: unknown) => state.domainZones.find((z) => z.id === id);
const zoneHostnames = (id: unknown) => state.hostnames.filter((h) => h.zoneId === id);
const zoneRecords = (id: unknown) => state.dnsRecords.filter((r) => r.zoneId === id);
const zoneMailboxes = (id: unknown) => state.mailboxes.filter((m) => m.zoneId === id);
const zoneAliases = (id: unknown) => state.mailAliases.filter((a) => a.zoneId === id);
const validHost = (v: string) => /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v);
const hostnameAvailable = (h?: HostnameRec) => h && !h.serviceId && domainZone(h.zoneId)?.status === 'verified';
const domainAssignment = (h?: HostnameRec) => h?.serviceId ? service(h.serviceId) : null;

function domainsView(): string {
  const zs = state.domainZones;
  const bound = state.domains.filter((d) => d.type === 'custom').length;
  return `${heading('NETWORKING / SINGLE SOURCE OF TRUTH', 'Domains', 'Register domains once. Manage DNS, subdomains, routing, SSL and email from one place.', btn(`${ico('plus', 15)} Add domain`, 'openModal', 'btn-primary', 'data-modal="domainRegister"'))}
 <div class="grid three" style="margin-bottom:19px">
  ${statsCard('globe', zs.length, 'Registered domains', 'One central domain registry')}
  ${statsCard('link', bound, 'Project connections', 'Assigned custom hostnames')}
  ${statsCard('shield', zs.filter((z) => z.status === 'verified').length, 'Verified domains', 'Eligible for app routing')}
 </div>
 <div class="soft-banner domain-banner" style="margin-bottom:16px">${ico('shield', 22)}<div><strong class="small">One entry point for domain management</strong><p>Add and verify domains here. Within an application, you only select an available hostname from this registry—no free-text domain creation.</p></div></div>
 <div class="section-head"><h2 class="section-title">Your domains</h2><span class="muted xs">${zs.length} registered</span></div>
 <div class="domain-zone-grid">${zs.map((z) => {
    const hosts = zoneHostnames(z.id), bindings = hosts.filter((h) => h.serviceId).length;
    return `<div class="card domain-zone-card"><div class="zone-head"><span class="zone-mark">${ico('globe', 17)}</span><div class="zone-identity"><h3 class="zone-name mono">${esc(z.name)}</h3><span class="zone-mode">${esc(dnsModeLabel(z))}</span></div><span class="zone-status">${statusBadge(z.status)}</span></div><div class="zone-explainer">${z.status === 'verified' ? 'Ready for project connections' : z.dnsMode === 'managed' ? 'Nameserver delegation pending (demo)' : 'DNS verification pending (demo)'}</div><div class="zone-bottom"><div class="zone-metrics"><span><strong>${hosts.length}</strong> hostname${hosts.length === 1 ? '' : 's'}</span><span class="zone-metric-divider" aria-hidden="true"></span><span><strong>${bindings}</strong> connected</span></div>${btn(`Manage ${ico('arrow', 14)}`, 'openDomain', 'zone-manage btn-small', `data-id="${z.id}"`)}</div></div>`;
  }).join('')}</div>
 <div class="section-head"><h2 class="section-title">Platform-generated application URLs</h2></div>
 <div class="card cl-default-address-card"><div class="row space"><div class="row"><span class="status-icon">${ico('cloud', 18)}</span><div><div class="strong small">*.apps.example.test</div><p class="muted xs">Automatically reserved for web applications and APIs. These URLs are platform-managed and cannot be assigned manually.</p></div></div>${badge('Managed by Cloudlane', 'blue')}</div></div>`;
}

const CLOUDLANE_DEMO_NS = ['ns1.dns.cloudlane.example', 'ns2.dns.cloudlane.example'];

function dnsModeLabel(z?: ZoneRec) {
  return (z?.dnsMode === 'managed' ? 'Cloudlane Managed DNS' : 'Manual DNS');
}

function dnsModeGuide(z: ZoneRec): string {
  const mode = z.pendingDnsMode || z.dnsMode;
  return `<div class="card dns-guide" style="margin-bottom:17px"><div class="row space"><h3 class="section-title">${mode === 'managed' ? 'Nameserver setup' : 'Manual DNS setup'}</h3>${badge(mode === 'managed' ? (z.status === 'verified' && !z.pendingDnsMode ? 'Delegation verified (demo)' : 'Delegation required') : 'Current nameservers stay', 'blue')}</div>${mode === 'managed' ? `<p class="muted small">Before changing your registrar's nameservers, copy your existing zone records and check DNSSEC/DS. Cloudlane would need two independent authoritative nameservers.</p><div class="dns-guide-grid">${CLOUDLANE_DEMO_NS.map((ns, i) => `<div class="dns-mini-panel"><div class="muted xs">${i === 0 ? 'Primary' : 'Secondary'} nameserver (example only)</div><div class="mono small" style="margin:7px 0">${ns}</div>${btn('Copy example', 'copy', 'btn-small', `data-copy="${ns}"`)}</div>`).join('')}</div><div class="notice">Do not enter these placeholder nameservers at a real registrar. They are NOT live.</div>` : `<p class="muted small">Keep your existing DNS provider. Copy the requested A/AAAA/CNAME/TXT/MX records to it, then verify ownership. No nameserver change is needed.</p><div class="row">${btn('Copy DNS checklist', 'copyDnsChecklist', 'btn-small', `data-id="${z.id}"`)}</div>`}<div class="row">${z.status !== 'verified' || z.pendingDnsMode ? btn(mode === 'managed' ? 'Preview delegation check' : 'Preview verification', 'openModal', 'btn-primary', 'data-modal="verifyZone"') : badge('Setup completed (demo)', 'ok')}</div></div>`;
}

function dnsModeSettingsPanel(z: ZoneRec): string {
  const proposed = z.pendingDnsMode;
  const mode = z.dnsMode === 'managed' ? 'managed' : 'manual';
  const modes = [
    ['manual', 'Manual DNS', 'Keep your current nameservers. Copy and manage live records at your existing DNS host.'],
    ['managed', 'Cloudlane Managed DNS', 'Delegate authoritative nameservers to Cloudlane; requires independent DNS infrastructure in production.']
  ];
  return `<div class="card" style="margin-bottom:18px"><div class="row space"><div><h3 class="section-title">DNS Management</h3><p class="muted xs" style="margin-top:4px">Choose how DNS is hosted for ${esc(z.name)}. The current mode stays active until a safe transition is verified.</p></div>${badge(dnsModeLabel(z), mode === 'managed' ? 'violet' : 'blue')}</div><div class="divider"></div><div class="dns-mode-grid">${modes.map(([id, label, description]) => `<div class="dns-mode-choice" style="cursor:default;${id === mode ? 'border-color:var(--mint);background:#142d2d;' : ''}"><div class="row space" style="align-items:center"><strong>${label}</strong>${id === mode ? badge('Current mode', 'ok') : badge('Available', 'blue')}</div><p>${description}</p>${id !== mode && !proposed ? `<div style="margin-top:8px">${btn(`Switch to ${label}`, 'dnsModeChange', 'btn-small', `data-id="${z.id}"`)}</div>` : ''}</div>`).join('')}</div>${proposed ? `<div class="notice" style="margin-top:15px"><strong>Pending transition:</strong> ${proposed === 'managed' ? 'Cloudlane Managed DNS' : 'Manual DNS'}. Existing DNS entries and project connections are preserved while this is reviewed.</div><div class="row" style="margin-top:13px">${btn('Review transition', 'openModal', 'btn-primary', 'data-modal="verifyZone"')}${btn('Cancel transition', 'cancelDnsTransition', '', `data-id="${z.id}"`)}</div>` : ''}<p class="hint" style="margin-top:14px">DNS records, verification instructions and nameserver setup are shown under DNS Records. No real DNS is published by this demo.</p></div>`;
}

function dnsChecklist(z: ZoneRec): string {
  return `DNS checklist for ${z.name} (demo — not published)\nMode: ${dnsModeLabel(z)}\n` +
    zoneRecords(z.id).map((r) => `${r.type}  ${r.name}  ${r.value}  TTL ${r.ttl || 3600}${r.priority !== undefined ? '  priority ' + r.priority : ''}`).join('\n') +
    (z.dnsMode === 'managed' ? '\n\nManaged zone preview only — not published.' : '\n\nCopy these at your current authoritative DNS provider when using manual DNS.');
}

function domainDetailView(): string {
  const z = domainZone(ui.domainZoneId);
  if (!z) return `<div class="card empty"><h3>Domain not found</h3>${btn('Back to Domains', 'go', '', 'data-page="domains"')}</div>`;
  const hs = zoneHostnames(z.id), records = zoneRecords(z.id), connections = hs.filter((h) => h.serviceId);
  const mb = zoneMailboxes(z.id), aliases = zoneAliases(z.id);
  const domainTabs = [
    ['overview', 'Overview'],
    ['dns-records', 'DNS Records'],
    ['subdomains', 'Subdomains'],
    ['connections', 'Connections'],
    ['ssl', 'SSL'],
    ['email', 'Email'],
    ['settings', 'Settings']
  ];
  let body = '';
  if (ui.tab === 'overview') body =
    `<div class="grid two-wide"><div class="col" style="gap:16px"><div class="card"><div class="row space"><h3 class="section-title">Domain overview</h3>${statusBadge(z.status)}</div><div class="kv" style="margin-top:9px"><span class="k">Domain</span><span class="v mono">${esc(z.name)}</span><span class="k">DNS management</span><span class="v">${dnsModeLabel(z)} (demo)</span><span class="k">Registered</span><span class="v">${date(z.created)}</span><span class="k">Hostnames</span><span class="v">${hs.length}</span><span class="k">Connections</span><span class="v">${connections.length} applications</span></div><div class="divider"></div>${btn(`${ico('file', 14)} View DNS records`, 'domainTab', '', 'data-tab="dns-records"')} ${btn(`${ico('link', 14)} View connections`, 'domainTab', '', 'data-tab="connections"')}</div><div class="card"><div class="row space"><h3 class="section-title">Recent hostnames</h3>${btn('View all', 'domainTab', 'btn-small', 'data-tab="subdomains"')}</div>${hs.slice(0, 5).map((h) => `<div class="host-row"><span class="mono small">${esc(h.name)}</span>${h.serviceId ? badge('Connected', 'ok') : badge('Available', 'blue')}</div>`).join('')}</div></div><div class="col" style="gap:16px"><div class="card"><h3 class="section-title">Domain readiness</h3><div class="readiness-list"><div>${ico('check', 16)} Domain entry created</div><div>${ico(z.status === 'verified' ? 'check' : 'alert', 16)} DNS ${z.status === 'verified' ? 'verified' : 'verification pending'}</div><div>${ico('shield', 16)} HTTPS for connected services</div><div>${ico('mail', 16)} Mailboxes and aliases</div></div>${z.status !== 'verified' ? btn('Verify ownership', 'openModal', 'btn-primary', 'data-modal="verifyZone"') : ''}</div><div class="card"><h3 class="section-title">How this connects to projects</h3><p class="muted small">Create hostnames here. In your application's Domains tab, select a verified, available hostname. Routes and certificates are then activated automatically (Caddy + on-demand TLS).</p><div style="margin-top:15px">${btn(`${ico('plus', 14)} Add subdomain`, 'openModal', '', 'data-modal="subdomain"')}</div></div></div></div>`;
  else if (ui.tab === 'dns-records') body =
    `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">DNS records</h3><p class="muted xs">${z.dnsMode === 'managed' ? 'Managed zone draft (demo): changes would publish to Cloudlane authoritative nameservers after delegation.' : 'Manual DNS checklist: update these records at your current authoritative DNS host.'}</p></div>${btn(`${ico('plus', 14)} Add record`, 'openModal', 'btn-primary', 'data-modal="dnsRecord"')}</div><div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Host</th><th>Value / target</th><th>TTL</th><th>Action</th></tr></thead><tbody>${records.map((r) => `<tr><td>${badge(r.type, r.type === 'MX' ? 'violet' : 'blue')}</td><td class="mono">${esc(r.name)}</td><td class="mono xs dns-value">${r.priority !== undefined ? `<span class="muted">${r.priority} · </span>` : ''}${esc(r.value)}</td><td class="mono">${esc(r.ttl || 3600)}s</td><td><div class="row">${btn('Edit', 'editDns', 'btn-small', `data-id="${r.id}"`)}${btn(`${ico('trash', 13)}`, 'deleteDns', 'btn-small', `data-id="${r.id}" aria-label="Delete DNS record"`)}</div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No DNS records yet.</td></tr>'}</tbody></table></div></div><div class="notice" style="margin-top:16px">${z.dnsMode === 'managed' ? 'Production requires authoritative nameserver infrastructure. Records here are only simulated and NOT published.' : 'You remain responsible for applying these records at your current DNS host. Edits here never change public DNS.'} ${btn('Copy DNS checklist', 'copyDnsChecklist', 'btn-small', `data-id="${z.id}"`)}</div>`;
  else if (ui.tab === 'subdomains') body =
    `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Subdomains</h3><p class="muted xs">Create names once, then attach them to any eligible application.</p></div>${btn(`${ico('plus', 14)} Create subdomain`, 'openModal', 'btn-primary', 'data-modal="subdomain"')}</div><div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Hostname</th><th>Type</th><th>Assignment</th><th>Actions</th></tr></thead><tbody>${hs.map((h) => `<tr><td class="mono main-cell">${esc(h.name)}</td><td>${h.type === 'apex' ? badge('Apex') : badge('Subdomain', 'blue')}</td><td>${h.serviceId ? `<span class="strong small">${esc(domainAssignment(h)?.name || '—')}</span>` : badge('Available', z.status === 'verified' ? 'ok' : 'warn')}</td><td><div class="row">${!h.serviceId ? btn('Connect', 'connectHost', 'btn-small', `data-id="${h.id}"`) : btn('Detach', 'unassignHostname', 'btn-small', `data-id="${h.id}"`)}${h.type !== 'apex' && !h.serviceId ? btn(`${ico('trash', 13)}`, 'deleteHostname', 'btn-small', `data-id="${h.id}" aria-label="Delete subdomain"`) : ''}</div></td></tr>`).join('')}</tbody></table></div></div>`;
  else if (ui.tab === 'connections') body =
    `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Project connections</h3><p class="muted xs">Hostname assignments are controlled by this registry.</p></div>${btn(`${ico('link', 14)} Connect application`, 'openModal', 'btn-primary', 'data-modal="domainAttach"')}</div><div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Hostname</th><th>Application</th><th>Project</th><th>Status</th><th>Action</th></tr></thead><tbody>${connections.map((h) => {
      const s = domainAssignment(h);
      return `<tr><td class="mono main-cell">${esc(h.name)}</td><td>${esc(s?.name || '—')}</td><td>${esc(project(s?.projectId)?.name || '—')}</td><td>${badge('Routing', 'ok')}</td><td>${btn('Disconnect', 'unassignHostname', 'btn-small', `data-id="${h.id}"`)}</td></tr>`;
    }).join('') || '<tr><td colspan="5"><div class="empty"><h3>No custom connections yet</h3><p>Assign an available hostname to an application or API.</p></div></td></tr>'}</tbody></table></div></div><p class="hint">Platform-generated *.apps.example.test addresses remain attached automatically and are managed by Cloudlane.</p>`;
  else if (ui.tab === 'ssl') body =
    `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">SSL certificates</h3><p class="muted xs">Certificate issuance and renewal simulation.</p></div>${btn(`${ico('refresh', 14)} Recheck HTTPS`, 'recheckSsl', '', `data-id="${z.id}"`)}</div><div class="soft-banner" style="margin-bottom:16px">${ico('shield', 21)}<div><strong class="small">Automatic HTTPS when connected</strong><p>Verified hostnames assigned to web apps receive HTTPS in this simulation. Production issuance requires real DNS and ACME validation.</p></div></div><div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Hostname</th><th>Certificate</th><th>Routing</th></tr></thead><tbody>${connections.map((h) => {
      const d = state.domains.find((d) => d.name === h.name);
      return `<tr><td class="mono main-cell">${esc(h.name)}</td><td>${d?.https ? badge('Active · demo', 'ok') : badge('Pending', 'warn')}</td><td>${statusBadge(d?.status || 'pending')}</td></tr>`;
    }).join('') || '<tr><td colspan="3"><div class="empty"><h3>No certificates yet</h3><p>Connect a verified hostname to an app to preview certificate issuance.</p></div></td></tr>'}</tbody></table></div></div>`;
  else if (ui.tab === 'email') body =
    `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Email for ${esc(z.name)}</h3><p class="muted xs">Manage mailbox identities and aliases under this domain.</p></div><div class="row">${btn(`${ico('plus', 14)} Mailbox`, 'openModal', 'btn-primary', 'data-modal="mailbox"')}${btn('Add alias', 'openModal', '', 'data-modal="mailAlias"')}</div></div><div class="soft-banner" style="margin-bottom:17px">${ico('mail', 20)}<div><strong class="small">Email management preview</strong><p>Mailboxes, aliases and a demo inbox are simulated. Production mail transport needs an external provider or optional mail-server installation.</p></div></div><div class="grid two-wide"><div class="card"><div class="row space"><h3 class="section-title">Mailboxes</h3>${badge(`${mb.length} active`, 'blue')}</div><div class="divider"></div>${mb.map((m) => `<div class="host-row"><div class="row"><span class="status-icon">${ico('mail', 16)}</span><div><div class="strong small">${esc(m.local)}@${esc(z.name)}</div><div class="muted xs">${m.quota} MB quota · Demo mailbox</div></div></div><div class="row">${btn('Open inbox', 'openInbox', 'btn-small', `data-id="${m.id}"`)}${btn(`${ico('trash', 13)}`, 'deleteMailbox', 'btn-small', `data-id="${m.id}" aria-label="Delete mailbox"`)}</div></div>`).join('') || '<p class="muted small">No mailboxes. Create your first email account.</p>'}</div><div class="col" style="gap:16px"><div class="card"><div class="row space"><h3 class="section-title">Email aliases</h3>${badge(`${aliases.length} aliases`, 'blue')}</div><div class="divider"></div>${aliases.map((a) => `<div class="host-row"><div><div class="strong small">${esc(a.local)}@${esc(z.name)}</div><div class="muted xs">Forwards to ${esc(a.target)}</div></div>${btn(`${ico('trash', 13)}`, 'deleteAlias', 'btn-small', `data-id="${a.id}" aria-label="Delete alias"`)}</div>`).join('') || '<p class="muted small">No aliases yet.</p>'}</div><div class="card"><h3 class="section-title">Mail DNS readiness</h3><div class="divider"></div>${['MX', 'TXT'].map((t) => `<div class="host-row"><span class="small">${t === 'MX' ? 'MX routing' : 'TXT / SPF policy'}</span>${records.some((r) => r.type === t) ? badge('Configured (demo)', 'ok') : badge('Missing', 'warn')}</div>`).join('')}<p class="hint">DKIM and DMARC must also be configured before sending real mail. Configure records in DNS Records.</p></div></div></div>`;
  else if (ui.tab === 'settings') body =
    `<div class="grid two-wide"><div class="card"><h3 class="section-title">Domain settings</h3><div class="kv" style="margin-top:15px"><span class="k">Domain</span><span class="v mono">${esc(z.name)}</span><span class="k">Management</span><span class="v">Cloudlane domain registry</span><span class="k">DNS provider</span><span class="v">${dnsModeLabel(z)} (demo)</span><span class="k">Verification</span><span class="v">${statusBadge(z.status)}</span></div><div class="divider"></div>${btn('View DNS records', 'domainTab', '', 'data-tab="dns-records"')}</div><div class="card"><h3 class="section-title">Danger zone</h3><p class="muted small">Removing a domain removes its simulated DNS entries, subdomains, mailboxes and aliases. Connected domains must be disconnected first.</p><div style="margin-top:18px">${btn(`${ico('trash', 14)} Remove domain`, 'deleteZone', 'btn-danger', `data-id="${z.id}"`)}</div></div></div>`;
  else body = '<div class="card empty">Select a domain section above.</div>';
  return `<button class="back" data-action="go" data-page="domains">${ico('back', 15)} All domains</button><div class="heading"><div><p class="eyebrow">DOMAIN / MANAGEMENT</p><div class="row" style="gap:12px"><span class="status-icon mint" style="height:42px;width:42px">${ico('globe', 22)}</span><h1 class="detail-title mono">${esc(z.name)}</h1>${statusBadge(z.status)}</div><p class="detail-meta">Central resource · ${hs.length} hostnames · ${connections.length} connected services</p></div><div class="head-actions">${btn(`${ico('plus', 14)} Subdomain`, 'openModal', '', 'data-modal="subdomain"')}${btn(`${ico('link', 14)} Connect app`, 'openModal', 'btn-primary', 'data-modal="domainAttach"')}</div></div><div class="tabs domain-tabs">${domainTabs.map(([key, label]) => `<button class="tab ${ui.tab === key ? 'active' : ''}" data-action="domainTab" data-tab="${key}">${label}</button>`).join('')}</div>${ui.tab === 'dns-records' ? dnsModeGuide(z) : ''}${ui.tab === 'settings' ? dnsModeSettingsPanel(z) : ''}${body}`;
}

function emailView(): string {
  const mail = state.mailboxes, aliases = state.mailAliases;
  return `${heading('NETWORKING / COMMUNICATION', 'Email', 'All mailboxes and aliases across your registered domains. Configure domain-specific email from Domains.', btn(`${ico('plus', 15)} New mailbox`, 'openModal', 'btn-primary', 'data-modal="mailbox"'))}
 <div class="grid three" style="margin-bottom:19px">${statsCard('mail', mail.length, 'Mailboxes', 'Demo mailbox identities')}${statsCard('link', aliases.length, 'Aliases', 'Forwarding addresses')}${statsCard('globe', state.domainZones.filter((z) => z.status === 'verified').length, 'Verified domains', 'Available for mail setup')}</div>
 <div class="soft-banner" style="margin-bottom:19px">${ico('info', 20)}<div><strong class="small">Email in the domain registry</strong><p>This is the workspace-wide view. Mail routing, MX/SPF/DKIM/DMARC, and domain-specific accounts are managed in Domains → Manage → Email or DNS Records. Mail delivery is not active in this demo.</p></div></div>
 <div class="row space" style="margin-bottom:14px"><h3 class="section-title">All mailboxes</h3>${btn('Manage domains', 'go', '', 'data-page="domains"')}</div>
 <div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Email address</th><th>Domain</th><th>Quota</th><th>Status</th><th>Actions</th></tr></thead><tbody>${mail.map((m) => {
    const z = domainZone(m.zoneId);
    return `<tr><td class="main-cell mono">${esc(m.local)}@${esc(z?.name || '—')}</td><td>${esc(z?.name || '—')}</td><td>${m.quota} MB</td><td>${badge('Demo active', 'ok')}</td><td><div class="row">${btn('Open inbox', 'openInbox', 'btn-small', `data-id="${m.id}"`)}${btn('Manage domain', 'openDomainEmail', 'btn-small', `data-id="${m.zoneId}"`)}</div></td></tr>`;
  }).join('') || '<tr><td colspan="5"><div class="empty"><h3>No mailboxes yet</h3><p>Add a mailbox under a registered domain.</p></div></td></tr>'}</tbody></table></div></div>
 <div class="section-head"><h2 class="section-title">Aliases</h2></div>
 <div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Alias</th><th>Forwards to</th><th>Domain</th><th>Manage</th></tr></thead><tbody>${aliases.map((a) => {
    const z = domainZone(a.zoneId);
    return `<tr><td class="mono main-cell">${esc(a.local)}@${esc(z?.name || '—')}</td><td class="mono xs">${esc(a.target)}</td><td>${esc(z?.name || '—')}</td><td>${btn('Manage', 'openDomainEmail', 'btn-small', `data-id="${a.zoneId}"`)}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="muted">No aliases configured yet.</td></tr>'}</tbody></table></div></div>`;
}

function serversView(): string {
  return `${heading('INFRASTRUCTURE', 'Servers', 'Manage the VPS that powers your projects.', '')}<div class="card" style="margin-bottom:18px"><div class="row space" style="flex-wrap:wrap;gap:18px"><div class="row"><span class="status-icon mint" style="width:45px;height:45px">${ico('server', 24)}</span><div><h3 style="margin:0 0 3px;font-size:17px">${esc(state.server.name)}</h3><div class="muted small">${esc(state.server.os)} · Docker runtime</div></div></div>${badge('Online', 'ok')}</div><div class="divider"></div><div class="grid four"><div><div class="muted xs">CPU</div><div style="font-size:21px;font-weight:730">1 <span class="muted xs">vCPU</span></div></div><div><div class="muted xs">Memory</div><div style="font-size:21px;font-weight:730">1 <span class="muted xs">GB</span></div></div><div><div class="muted xs">Storage</div><div style="font-size:21px;font-weight:730">10 <span class="muted xs">GB</span></div></div><div><div class="muted xs">Agent</div><div style="font-size:18px;font-weight:730;color:var(--mint)">Connected</div></div></div><div class="divider"></div>${healthBlock()}</div><div class="grid two"><div class="card"><div class="row"><span class="status-icon gold">${ico('alert', 18)}</span><h3 class="section-title">Minimum VPS profile</h3></div><p class="muted small">Designed for Ubuntu 20.04+ with a lightweight single-node control plane, but production support and runtime compatibility should be validated per OS release.</p><div class="notice" style="margin-top:14px"><strong>Resource reality check:</strong> A 1 GB / 1 vCPU / 10 GB VPS cannot reliably build and host multiple heavy Next.js apps and databases together. Production builds should use an external builder or a larger machine; enforce quotas and reserve disk space.</div></div><div class="card"><div class="row"><span class="status-icon">${ico('shield', 18)}</span><h3 class="section-title">Protection by default</h3></div><div class="col" style="margin-top:16px;gap:12px">${[['Isolated application workloads', 'Container resource limits'], ['Internal database networking', 'External exposure opt-in only'], ['Control-plane separation', 'No Docker socket for user apps'], ['Agent operations', 'Allowlisted and authenticated']].map(([a, b]) => `<div class="row space"><span class="small">${a}</span><span class="muted xs">${b}</span></div>`).join('')}</div></div></div>`;
}

function activityView(): string {
  return `${heading('AUDIT & EVENTS', 'Activity & Logs', 'Operations across deployments, infrastructure, and user actions.', '')}<div class="card"><div class="row space" style="margin-bottom:12px"><h3 class="section-title">Recent events</h3>${badge(`${state.activities.length} events`, 'blue')}</div>${activityMarkup(state.activities)}</div>`;
}

function emptyMissing(type: string): string {
  return `<div class="card empty"><h3>${esc(type)} not found</h3>${btn('Back to projects', 'go', '', 'data-page="projects"')}</div>`;
}

function serviceView(): string {
  const s = service(ui.serviceId);
  if (!s) return emptyMissing('Service');
  if (s.kind === 'storage') return storageServiceView(s);
  const p = project(s.projectId);
  const app = s.kind === 'application';
  const tabs = app ? ['overview', 'deployments', 'logs', 'terminal', 'domains', 'variables', 'artifacts', 'volumes', 'settings']
    : s.kind === 'database' ? ['overview', 'connections', 'console', 'users', 'backups', 'settings']
    : ['overview', 'executions', 'settings'];
  const sub = app ? `${s.framework} · ${cap(s.role)} · ${s.source === 'github' ? 'GitHub repository' : 'ZIP upload'}`
    : s.kind === 'database' ? `${s.engine} · ${s.database}`
    : `Scheduled ${s.method || 'HTTP'} request · ${s.timezone}`;
  return `<button class="back" data-action="openProject" data-id="${s.projectId}">${ico('back', 15)} ${esc(p?.name || 'Project')}</button><div class="heading"><div><p class="eyebrow">${esc(p?.name || 'PROJECT')} / PRODUCTION</p><div class="row" style="gap:11px"><span class="status-icon ${s.kind === 'database' || s.kind === 'storage' ? 'gold' : s.kind === 'cron' ? 'purple' : 'mint'}" style="width:40px;height:40px">${ico(s.kind === 'storage' ? 'bucket' : itemIcon(s), 20)}</span><h1 class="detail-title">${esc(s.name)}</h1>${statusBadge(s.status)}</div><p class="detail-meta">${esc(sub)}</p></div><div class="head-actions">${s.kind === 'database' ? btn(`${ico('external', 15)} Open ${s.engine === 'PostgreSQL' ? 'Adminer' : 'phpMyAdmin'}`, 'openModal', 'btn-primary', `data-modal="dbAdmin" data-service="${s.id}"`) : ''}</div></div><div class="tabs">${tabs.map((t) => `<button class="tab ${ui.tab === t ? 'active' : ''}" data-action="serviceTab" data-tab="${t}">${cap(t)}</button>`).join('')}</div>${app ? applicationService(s) : s.kind === 'database' ? databaseService(s) : cronService(s)}`;
}

function applicationService(s: ServiceRec): string {
  const ds = deploymentsFor(s.id);
  const d = ds[0];
  if (ui.tab === 'terminal') return terminalView(s);
  if (ui.tab === 'artifacts') return appArtifactsView(s);
  if (ui.tab === 'volumes') return appVolumesView(s);
  if (ui.tab === 'overview')
    return `<div class="grid two-wide"><div class="col" style="gap:17px"><div class="card"><div class="row space"><h3 class="section-title">Live application</h3>${statusBadge(s.status)}</div><p class="muted small">Production deployment endpoint</p><div class="callout"><div class="row space"><div class="col"><span class="muted xs">Public URL</span><span class="mono" style="font-size:13px;color:var(--mint);overflow-wrap:anywhere">https://${esc(primaryDomain(s.id))}</span></div>${btn(`${ico('copy', 14)} Copy`, 'copy', 'btn-small', `data-copy="https://${attr(primaryDomain(s.id))}"`)}</div></div><div class="divider"></div><div class="grid two"><div class="kv"><span class="k">Framework</span><span class="v">${esc(s.framework)}</span><span class="k">Role</span><span class="v">${cap(s.role)}</span></div><div class="kv"><span class="k">Environment</span><span class="v">production</span><span class="k">Runtime</span><span class="v">Docker</span></div></div></div><div class="card"><div class="row space"><h3 class="section-title">Live preview</h3>${primaryDomain(s.id) !== 'Not configured' ? btn('Open in new tab', 'openExternal', 'btn-small', `data-url="https://${attr(primaryDomain(s.id))}"`) : ''}</div>${isVisualApp(s) ? `<div style="margin-top:12px;border:1px solid var(--border);border-radius:10px;overflow:hidden;height:280px;background:#0b1518"><iframe src="https://${attr(primaryDomain(s.id))}" loading="lazy" sandbox="allow-scripts" style="width:1440px;height:875px;border:0;transform:scale(0.33);transform-origin:0 0;pointer-events:none" title="Live preview"></iframe></div><p class="hint">Live view of the production URL. Use Open in new tab for the full app.</p>` : `<div style="margin-top:12px;border:1px dashed var(--border);border-radius:10px;height:170px;display:flex;align-items:center;justify-content:center;gap:9px;color:var(--muted)">${ico('terminal', 24)}<span class="small">Backend service — no visual preview</span></div>`}</div><div class="card"><div class="row space"><h3 class="section-title">Latest deployment</h3><button class="link" data-action="serviceTab" data-tab="deployments">Deployment history</button></div>${d ? `<div class="row space" style="margin-top:17px"><div><div class="row">${statusBadge(d.status)}<span class="mono muted xs">${esc(d.revision)}</span></div><p class="muted xs">Started ${age(d.created)}</p></div>${btn('View logs', 'serviceTab', 'btn-small', 'data-tab="logs"')}</div>${d.status !== 'LIVE' && d.status !== 'FAILED' ? `<div class="progress skeleton"><span style="width:${Math.max(8, Number(d.stage) * 12)}%"></span></div>` : ''}` : '<p class="muted small">No deployment yet</p>'}</div></div></div><div class="col" style="gap:17px"><div class="card"><h3 class="section-title">Source control</h3><div class="divider"></div><div class="row"><span class="status-icon">${ico(s.source === 'github' ? 'github' : 'archive', 17)}</span><div><div class="strong small">${esc(s.source === 'github' ? s.repo : s.fileName || 'Uploaded archive')}</div><div class="muted xs">${s.source === 'github' ? `Branch ${esc(s.branch || 'main')}` : 'Local ZIP source'}</div></div></div>${s.source === 'github' ? `<div class="divider"></div><div class="row space"><span class="muted xs">Automatic deploy</span>${badge(s.autoDeploy ? 'Enabled' : 'Disabled', s.autoDeploy ? 'ok' : 'warn')}</div><div style="margin-top:12px">${btn(`${ico('branch', 14)} Simulate new commit`, 'simulatePush', 'btn-small', `data-id="${s.id}"`)}</div>` : ''}</div><div class="card"><h3 class="section-title">Health &amp; networking</h3><div class="divider"></div><div class="row space"><span class="muted small">Health check</span>${statusBadge(s.status === 'running' ? 'healthy' : s.status)}</div><div class="row space" style="margin-top:11px"><span class="muted small">Domains</span><strong class="small">${domainsFor(s.id).length}</strong></div><div class="row space" style="margin-top:11px"><span class="muted small">Build strategy</span><strong class="small">Auto-detected</strong></div></div></div></div>`;
  if (ui.tab === 'deployments')
    return `<div class="row space" style="margin-bottom:16px"><h3 class="section-title">Deployment history</h3>${btn(`${ico('refresh', 14)} Redeploy`, 'redeploy', '', `data-id="${s.id}"`)}</div><div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Release</th><th>Revision</th><th>Started</th><th>Status</th><th>Actions</th></tr></thead><tbody>${ds.map((d) => `<tr><td class="mono main-cell">${esc(d.id)}</td><td class="mono">${esc(d.revision)}</td><td>${date(d.created)}</td><td>${statusBadge(d.status)}</td><td><div class="row">${btn('Logs', 'openLogs', 'btn-small', `data-id="${d.id}"`)}${d.status === 'LIVE' && d.id !== s.activeDeployment ? btn('Rollback', 'rollback', 'btn-small', `data-id="${d.id}"`) : ''}</div></td></tr>`).join('')}</tbody></table></div></div><p class="hint">Rollback reactivates a retained successful release.</p>`;
  if (ui.tab === 'logs') {
    const selected = ui.modalData.logDeployment && ds.find((x) => x.id === ui.modalData.logDeployment) || d;
    return `<div class="card"><div class="row space"><h3 class="section-title">Build &amp; deployment logs</h3><button class="btn btn-small" data-action="assistantOpen" data-prompt="Explain the latest logs for ${attr(s.name)}">${ico('sparkles', 14)} Explain with assistant</button>${badge(selected?.status || '—', selected?.status === 'LIVE' ? 'ok' : 'blue')}</div><p class="muted xs">${esc(selected?.id || '—')} · ${date(selected?.created)}</p><div class="codebox" style="margin-top:15px">${(selected?.logs || []).map((line) => `<span class="${line.level === 'error' ? 'error' : line.level === 'success' ? 'success' : 'info'}">${esc(line.msg)}</span>`).join('\n') || '<span class="info">Logs will appear here.</span>'}</div>${selected && selected.status !== 'LIVE' && selected.status !== 'FAILED' ? '<p class="hint skeleton">Deployment is progressing…</p>' : ''}</div>`;
  }
  if (ui.tab === 'domains')
    return `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Application domains</h3><p class="muted xs">Choose from verified domains created in the central registry.</p></div>${btn(`${ico('link', 15)} Connect domain`, 'openModal', 'btn-primary', `data-modal="domainAttach" data-service="${s.id}"`)}</div><div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>Hostname</th><th>Type</th><th>Status</th><th>HTTPS</th><th>Action</th></tr></thead><tbody>${domainsFor(s.id).map((d) => `<tr><td class="mono main-cell">${esc(d.name)}</td><td>${esc(d.type === 'platform' ? 'Default platform URL' : 'Custom domain')}</td><td>${statusBadge(d.status)}</td><td>${d.https ? badge('Enabled', 'ok') : badge('Pending', 'warn')}</td><td>${d.type === 'platform' ? '<span class="muted xs">Always available</span>' : `<div class="row">${btn('Manage', 'openDomain', 'btn-small', `data-id="${state.hostnames.find((h) => h.name === d.name)?.zoneId || ''}"`)}${btn('Detach', 'unassignHostname', 'btn-small', `data-id="${state.hostnames.find((h) => h.name === d.name)?.id || ''}"`)}</div>`}</td></tr>`).join('')}</tbody></table></div></div><div class="soft-banner" style="margin-top:17px">${ico('globe', 18)}<div><strong class="small">Domain management stays centralized</strong><p>Need a new domain, DNS record, or subdomain? Go to <button class="link" data-action="go" data-page="domains">Domains</button> first, then return here to connect it.</p></div></div>`;
  if (ui.tab === 'variables')
    return `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Environment variables</h3><p class="muted xs">Values are encrypted at rest and injected into the container runtime.</p></div>${btn(`${ico('plus', 15)} Add variable`, 'openModal', 'btn-primary', `data-modal="variable" data-service="${s.id}"`)}</div><div class="card table-frame"><table class="table"><thead><tr><th>Key</th><th>Value</th><th>Actions</th></tr></thead><tbody>${(s.variables || []).map((v, i) => `<tr><td class="main-cell mono">${esc(v.key)}</td><td class="mono muted">••••••••••••</td><td>${btn(`${ico('trash', 13)} Remove`, 'removeVar', 'btn-small', `data-id="${s.id}" data-index="${i}"`)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No variables yet.</td></tr>'}</tbody></table></div><p class="hint">Changing variables creates a new configuration revision and requires a redeployment.</p>`;
  return `<div class="grid two"><div class="card"><h3 class="section-title">Service configuration</h3><div class="kv"><span class="k">Source</span><span class="v">${esc(cap(s.source))}</span><span class="k">Framework</span><span class="v">${esc(s.framework)}</span><span class="k">Role</span><span class="v">${esc(cap(s.role))}</span><span class="k">Created</span><span class="v">${date(s.created)}</span></div></div><div class="card"><h3 class="section-title">Deployment testing</h3><p class="muted small">Verify failure handling by simulating a broken build or failing health check.</p><div class="col" style="margin-top:14px;align-items:flex-start">${btn('Simulate build failure', 'failBuild', '', `data-id="${s.id}"`)}${btn('Simulate health-check failure', 'failHealth', '', `data-id="${s.id}"`)}</div></div></div>`;
}

const safePreviewCommands = ['help', 'pwd', 'ls', 'ls -la', 'whoami', 'node --version',
  'npm --version', 'ps', 'date', 'cat package.json', 'git status', 'env', 'clear', 'exit'];

function terminalAllowed(_s?: ServiceRec): boolean {
  return ui.termRole === 'developer' || ui.termRole === 'admin';
}
function terminalSession(s: ServiceRec) {
  if ((ui.termSession as { serviceId: string } | null)?.serviceId !== s.id) return null;
  const sess = ui.termSession as { expiresAt: number } | null;
  if (sess && sess.expiresAt <= Date.now()) {
    endTerminalSession('Session expired. Reopen to continue.');
    return null;
  }
  return ui.termSession;
}
function endTerminalSession(note = 'Terminal session ended.'): void {
  const session = ui.termSession as { serviceId: string } | null;
  if (termExpiryTimer) { clearTimeout(termExpiryTimer); termExpiryTimer = null; }
  ui.termSession = null;
  if (session) activity('Terminal session closed', `${service(session.serviceId)?.name || 'Application'} · ${note}`, 'system');
}
let termExpiryTimer: ReturnType<typeof setTimeout> | null = null;

function terminalView(s: ServiceRec): string {
  const eligible = !(s.role === 'static' || /^(HTML|Static|Vite static)$/i.test(String(s.framework || '')));
  const active = terminalSession(s) as { expiresAt: number; entries: { kind: string; text: string }[] } | null;
  const remaining = active ? Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000)) : 0;
  void remaining;
  const entries = active?.entries || [];
  return `<div class="term-banner" style="margin-bottom:17px">${ico('shield', 19)}<div><strong>Application container only · demonstration</strong><div style="margin-top:3px">No VPS host shell, SSH, Docker daemon, system directories, or real command execution. This preview accepts only a small set of fake read-only commands; production sessions will require container isolation and audited role permissions.</div></div></div>
 <div class="term-two"><div class="card"><div class="row space" style="gap:12px;flex-wrap:wrap"><div><h3 class="section-title">Application Terminal</h3><p class="muted xs">${esc(s.name)} · production · isolated app user</p></div>${active ? badge('Session active', 'ok') : badge('Not connected', 'warn')}</div><div class="divider"></div>
 ${!eligible ? `<div class="notice">This static-site service has no interactive application process in the demo. Review its deployment artifacts and logs instead.</div>${btn('View logs', 'serviceTab', '', 'data-tab="logs"')}` :
    `<div class="row space" style="flex-wrap:wrap;gap:12px;margin-bottom:15px"><label class="form-label">Preview role<select id="terminalDemoRole" class="term-select" aria-label="Select demo terminal permission role"><option value="viewer" ${ui.termRole === 'viewer' ? 'selected' : ''}>Viewer · no terminal access</option><option value="developer" ${ui.termRole === 'developer' ? 'selected' : ''}>Developer · permitted</option><option value="admin" ${ui.termRole === 'admin' ? 'selected' : ''}>Administrator · permitted</option></select></label><div class="col" style="align-items:flex-start"><span class="muted xs">Session limits</span><span class="strong small">5 minutes · application-scoped</span>${active ? `<span class="muted xs">Expires at ${new Date(active.expiresAt).toLocaleTimeString()}</span>` : ''}</div></div>
 ${!terminalAllowed(s) ? `<div class="notice">${ico('lock', 16)} Terminal access denied for Viewer. Logs and application metrics remain available.</div>` : !active ? `<div class="term-console"><div class="term-toolbar"><span class="mono small">app@${esc(s.name)}:~$</span>${badge('Waiting for approval', 'warn')}</div><div class="term-screen"><span class="system">Terminal is disabled by default. Start a short-lived, container-only demo session to inspect supported commands. No actual shell will be opened.</span></div></div><div class="term-actions">${btn(`${ico('terminal', 15)} Start demo session`, 'terminalStart', 'btn-primary', `data-id="${s.id}"`)}</div><p class="hint">By starting, you acknowledge that a real terminal can access files and secrets allowed by the container identity. Production access needs an explicit permission grant.</p>` :
    `<div class="term-console"><div class="term-toolbar"><span class="row"><span class="dot"></span><span class="mono small">app@${esc(s.name)}:/app</span></span><span class="muted xs">Expires ${new Date(active.expiresAt).toLocaleTimeString()}</span></div><div class="term-screen" id="terminalOutput" role="log" aria-live="polite">${entries.map((e) => `<div class="${e.kind}">${esc(e.text)}</div>`).join('')}</div><form id="terminalDemoForm" class="term-command"><label for="terminalCommand">app $</label><input id="terminalCommand" name="command" maxlength="160" autocomplete="off" spellcheck="false" placeholder="Type help or pwd" aria-label="Demo shell command"><button class="btn btn-primary btn-small" type="submit">Run demo</button></form></div><div class="term-actions">${btn('End session', 'terminalEnd', 'btn-small')}${btn('Simulate expiry', 'terminalExpire', 'btn-small')}${btn('Copy transcript', 'terminalCopy', 'btn-small')}${btn('Clear output', 'terminalClear', 'btn-small')}</div>`}`}
 </div><div class="col" style="gap:17px"><div class="card"><h3 class="section-title">Safe preview commands</h3><p class="muted xs" style="margin:8px 0 15px">Only these examples return simulated results.</p><div class="row" style="flex-wrap:wrap;gap:7px">${safePreviewCommands.filter((c) => !['env', 'clear', 'exit'].includes(c)).map((c) => `<button type="button" class="term-command-chip" data-action="terminalFill" data-command="${attr(c)}">${esc(c)}</button>`).join('')}</div><p class="hint">env outputs no secrets. Unknown and destructive commands are rejected.</p></div><div class="card"><h3 class="section-title">Access boundaries</h3><div class="access-list"><div>${ico('check', 15)} Non-root user inside one container</div><div>${ico('check', 15)} Short-lived, scoped sessions</div><div>${ico('check', 15)} Audit start, expiry and blocked attempts</div><div>${ico('shield', 15)} No VPS filesystem explorer</div><div>${ico('shield', 15)} No SSH, sudo or Docker socket</div></div><div class="divider"></div>${btn('Review activity logs', 'go', '', 'data-page="activity"')}</div></div></div>`;
}

function consolePreview(s: ServiceRec): string {
  const postgres = s.engine === 'PostgreSQL';
  const samples = postgres ? ['SELECT current_database()', 'SELECT table_name FROM information_schema.tables LIMIT 5', 'SELECT * FROM users LIMIT 5']
    : ['SELECT DATABASE()', 'SHOW TABLES', 'SELECT * FROM users LIMIT 5'];
  const output = (ui.sqlResult as { serviceId: string; blocked: boolean; columns: string[]; rows: unknown[][]; message: string } | null)?.serviceId === s.id ? ui.sqlResult : null;
  return `<div class="term-banner" style="margin-bottom:17px">${ico('shield', 18)}<div><strong>Read-only database console · simulation</strong><div style="margin-top:3px">This is a canned SQL preview, not a database connection. In production the SQL console needs separate database credentials, scoped permissions, session expiry, query limits and auditing.</div></div></div><div class="sql-cards"><div class="card"><div class="row space"><div><h3 class="section-title">${esc(s.engine)} console</h3><p class="muted xs">${esc(s.database)} · production</p></div>${badge('Read-only demo', 'blue')}</div><div class="divider"></div><form id="sqlConsoleForm"><label class="form-label" for="sqlQuery">Query editor</label><textarea name="query" id="sqlQuery" class="sql-editor" maxlength="300" required spellcheck="false" placeholder="${attr(samples[0])}">${esc(String(ui.sqlDraft) || samples[0])}</textarea><div class="row space" style="flex-wrap:wrap;margin-top:11px"><button type="submit" class="btn btn-primary">${ico('play', 14)} Run preview</button><span class="muted xs">SELECT-only samples · no actual queries</span></div></form>${output ? `<div class="divider"></div><div class="row space"><h3 class="section-title">Result</h3>${badge(output.blocked ? 'Not permitted' : `${output.rows.length} rows`, output.blocked ? 'warn' : 'ok')}</div><p class="muted xs" style="margin:10px 0">${esc(output.message)}</p>${!output.blocked ? `<div class="table-wrap"><table class="table"><thead><tr>${output.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${output.rows.map((row) => `<tr>${row.map((v) => `<td class="mono">${esc(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}` : ''}</div><div class="col" style="gap:17px"><div class="card"><h3 class="section-title">Example queries</h3><div class="col" style="margin-top:14px;align-items:flex-start">${samples.map((q) => `<button class="term-command-chip" data-action="sqlFill" data-query="${attr(q)}">${esc(q)}</button>`).join('')}</div></div><div class="card"><h3 class="section-title">Database administration</h3><p class="muted small">For full database administration, use the engine-specific administration tool with separate authentication and database privileges.</p><div style="margin-top:14px">${btn(`${ico('external', 15)} Open ${postgres ? 'Adminer' : 'phpMyAdmin'}`, 'openModal', '', `data-modal="dbAdmin" data-service="${s.id}"`)}</div><p class="hint">Signed in automatically as the database application user.</p></div></div></div>`;
}

function databaseService(s: ServiceRec): string {
  if (ui.tab === 'console') return consolePreview(s);
  if (ui.tab === 'overview' || ui.tab === 'connections') {
    const host = s.external ? 'db.example.test' : `${s.name}.internal`;
    const port = s.engine === 'PostgreSQL' ? '5432' : '3306';
    const user = (s.name || '').replace(/[^a-z0-9]/gi, '_');
    const dbUrl = `${s.engine === 'PostgreSQL' ? 'postgresql' : 'mysql'}://${user}:${s.password}@${host}:${port}/${s.database}${s.engine === 'PostgreSQL' ? '?sslmode=require' : ''}`;
    return `<div class="grid two-wide"><div class="card"><div class="row space"><h3 class="section-title">Connection details</h3>${badge(s.external ? 'Restricted external' : 'Private only', s.external ? 'warn' : 'ok')}</div><p class="muted small">Credentials are encrypted at rest. Rotate them after sharing.</p><div class="kv" style="margin-top:10px"><span class="k">Database</span><span class="v mono">${esc(s.database)}</span><span class="k">Engine</span><span class="v">${esc(s.engine)} ${esc(s.version || '')}</span><span class="k">Host</span><span class="v mono">${esc(host)}</span><span class="k">Port</span><span class="v mono">${port}</span><span class="k">Username</span><span class="v mono">${esc(user)}</span><span class="k">Password</span><span class="v mono">${ui.showPassword ? esc(s.password) : '••••••••••••'} <button class="link" data-action="togglePass">${ico(ui.showPassword ? 'eyeoff' : 'eye', 14)}</button></span></div><div class="divider"></div><div class="row space"><h3 class="section-title">Connection string</h3>${btn(`${ico('copy', 14)} Copy`, 'copy', 'btn-small', `data-copy="${attr(dbUrl)}"`)}</div><div class="codebox" style="max-height:94px;word-break:break-all">${esc(ui.showPassword ? dbUrl : dbUrl.replace(s.password ?? '', '••••••••'))}</div></div><div class="col" style="gap:16px"><div class="card"><h3 class="section-title">Network access</h3><p class="muted small">External connections are disabled by default.</p><div class="row space" style="margin-top:13px"><span class="muted small">External access</span>${badge(s.external ? 'Enabled' : 'Disabled', s.external ? 'warn' : 'ok')}</div>${s.external ? `<div class="row space" style="margin-top:12px"><span class="muted small">Allowed source</span><span class="mono xs">${esc(s.allowedIp)}</span></div>` : ''}<div style="margin-top:16px">${btn(s.external ? 'Disable external access' : 'Configure external access', 'dbAccess', '', `data-id="${s.id}"`)}</div></div><div class="card"><h3 class="section-title">Safety</h3><p class="muted small">Rotate credentials to immediately invalidate the previous secret.</p><div style="margin-top:12px">${btn(`${ico('refresh', 14)} Rotate password`, 'rotateDb', 'btn-small', `data-id="${s.id}"`)}</div></div></div></div>`;
  }
  if (ui.tab === 'users') {
    const users = state.dbUsers.filter((u) => u.serviceId === s.id);
    return `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Database users</h3><p class="muted xs">Manage individual database accounts and privileges.</p></div>${btn(`${ico('plus', 15)} Add user`, 'openModal', 'btn-primary', `data-modal="dbUserAdd" data-service="${s.id}"`)}</div>
  <div class="card table-frame"><div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Access</th><th>Privileges</th><th>Actions</th></tr></thead><tbody>${users.map((u) => `<tr><td class="mono main-cell">${esc(u.username)}</td><td>${badge(u.revoked ? 'Revoked' : 'Active', u.revoked ? 'warn' : 'ok')}</td><td><span class="muted small">${u.privileges.length === dbPrivileges(s).length ? 'Full access' : u.privileges.length + ' privileges'}</span></td><td><div class="row">${btn('Manage', 'openDbUser', 'btn-small', `data-id="${u.id}"`)}${btn('Privileges', 'openDbPrivileges', 'btn-small', `data-id="${u.id}"`)}${btn(u.revoked ? 'Restore' : 'Revoke access', 'toggleDbUser', 'btn-small', `data-id="${u.id}"`)}</div></td></tr>`).join('') || '<tr><td colspan="4"><div class="empty"><h3>No database users</h3><p>Add a user with only the permissions it needs.</p></div></td></tr>'}</tbody></table></div></div>
  <p class="hint" style="margin-top:14px">Privileges are scoped to this database. MySQL and PostgreSQL expose different privileges.</p>`;
  }
  if (ui.tab === 'backups')
    return `<div class="row space" style="margin-bottom:16px"><h3 class="section-title">Database backups</h3>${btn(`${ico('plus', 15)} Create backup`, 'backupDb', 'btn-primary', `data-id="${s.id}"`)}</div><div class="card table-frame"><table class="table"><thead><tr><th>Backup</th><th>Date</th><th>Type</th><th>Status</th></tr></thead><tbody>${(s.backups || []).map((b) => `<tr><td class="main-cell mono">${esc(b.id)}</td><td>${date(b.created)}</td><td>Snapshot</td><td>${statusBadge(b.status)}</td></tr>`).join('') || `<tr><td colspan="4"><div class="empty"><h3>No backups yet</h3><p>Create a backup to snapshot this database.</p></div></td></tr>`}</tbody></table></div>`;
  return `<div class="card"><h3 class="section-title">Database settings</h3><div class="kv"><span class="k">Name</span><span class="v">${esc(s.name)}</span><span class="k">Engine</span><span class="v">${esc(s.engine)}</span><span class="k">Environment</span><span class="v">production</span><span class="k">Status</span><span class="v">${statusBadge(s.status)}</span></div><div class="notice" style="margin-top:15px">Production requirements: isolated database users, network allowlists, TLS, off-server backups, restore testing and storage monitoring.</div></div>`;
}

const MYSQL_PRIVS = ['ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE',
  'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX',
  'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
const PG_PRIVS = ['CONNECT', 'CREATE', 'TEMPORARY', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE',
  'TRUNCATE', 'REFERENCES', 'TRIGGER', 'EXECUTE'];
const dbPrivileges = (db: ServiceRec) => db.engine === 'PostgreSQL' ? PG_PRIVS : MYSQL_PRIVS;
const userFor = (id: unknown) => state.dbUsers.find((u) => u.id === id);

function cronService(s: ServiceRec): string {
  const runs = state.cronRuns.filter((r) => r.serviceId === s.id);
  if (ui.tab === 'overview')
    return `<div class="grid two-wide"><div class="card"><div class="row space"><h3 class="section-title">Cron configuration</h3>${statusBadge(s.status)}</div><div class="kv" style="margin-top:14px"><span class="k">Schedule</span><span class="v mono">${esc(s.schedule)}</span><span class="k">Timezone</span><span class="v">${esc(s.timezone)}</span><span class="k">HTTP method</span><span class="v">${esc(s.method)}</span><span class="k">Target URL</span><span class="v mono">${esc(s.target)}</span></div><div class="divider"></div><div class="row space"><span class="muted small">Job status</span>${btn(s.enabled ? `${ico('pause', 14)} Pause` : `${ico('play', 14)} Resume`, 'toggleCron', '', `data-id="${s.id}"`)}</div></div><div class="card"><h3 class="section-title">Recent execution</h3>${runs[0] ? `<div class="row space" style="margin-top:15px">${statusBadge(runs[0].status)}<span class="muted xs">${age(runs[0].created)}</span></div><div class="kv"><span class="k">Response</span><span class="v mono">${esc(runs[0].code || '—')}</span><span class="k">Duration</span><span class="v mono">${esc(runs[0].duration || '—')}</span></div>` : '<p class="muted small">Not executed yet.</p>'}<div class="divider"></div>${btn(`${ico('play', 14)} Run now`, 'runCron', 'btn-primary', `data-id="${s.id}"`)}</div></div>`;
  if (ui.tab === 'executions')
    return `<div class="row space" style="margin-bottom:16px"><h3 class="section-title">Execution history</h3>${btn(`${ico('play', 15)} Run now`, 'runCron', 'btn-primary', `data-id="${s.id}"`)}</div><div class="card table-frame"><table class="table"><thead><tr><th>Run</th><th>Time</th><th>Status</th><th>Response</th><th>Duration</th></tr></thead><tbody>${runs.map((r) => `<tr><td class="main-cell mono">${esc(r.id)}</td><td>${date(r.created)}</td><td>${statusBadge(r.status)}</td><td class="mono">${esc(r.code || '—')}</td><td class="mono">${esc(r.duration || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No executions yet.</td></tr>'}</tbody></table></div>`;
  return `<div class="card"><h3 class="section-title">Cron settings</h3><div class="kv"><span class="k">Name</span><span class="v">${esc(s.name)}</span><span class="k">Schedule</span><span class="v mono">${esc(s.schedule)}</span><span class="k">Timezone</span><span class="v">${esc(s.timezone)}</span></div><div class="notice" style="margin-top:16px">Production HTTP jobs need protected credentials, SSRF prevention, HTTPS verification, timeout and retry controls, and idempotency keys.</div></div>`;
}

/* ── storage (v1.7) ── */
const storageService = (id: unknown) => state.services.find((x) => x.id === id && x.kind === 'storage');
const bucket = (id: unknown) => state.buckets.find((b) => b.id === id);
const bucketsFor = (id: unknown) => state.buckets.filter((b) => b.storageId === id);
const objectsFor = (id: unknown) => state.objects.filter((o) => o.bucketId === id);
const grantsFor = (id: unknown) => state.storageGrants.filter((g) => g.storageId === id);
const bytesHuman = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const totalBytes = (id: unknown) => objectsFor(id).reduce((n, o) => n + o.size, 0);
const storageTotal = (id: unknown) => bucketsFor(id).reduce((n, b) => n + totalBytes(b.id), 0);
const storageSafeName = (x: string) => /^[a-z][a-z0-9-]{2,51}$/.test(x);
const storageSafePrefix = (x: string) => /^(?:[a-zA-Z0-9_-]+\/)*$/.test(x);

function storageBanner(): string {
  return `<div class="storage-privacy">${ico('shield', 24)}<div><strong>File isolation enforced by design</strong><p>Object storage operates on buckets and object keys only. Application releases are read-only; persistent volumes are allocated separately. There is no host filesystem browsing, SSH, Docker socket, or VPS root access through this interface.</p></div></div>`;
}

function storageOverview(): string {
  const all = state.services.filter((s) => s.kind === 'storage');
  const count = state.buckets.length;
  return `${heading('PROJECT RESOURCES', 'Object Storage', 'Bucket-based file storage for application media, uploads, and private documents.', btn(`${ico('plus', 15)} Add storage`, 'openModal', 'btn-primary', 'data-modal="storageCreate"'))}${storageBanner()}<div class="grid three" style="margin-bottom:18px">${statsCard('bucket', all.length, 'Storage services', 'External S3-compatible connections')}${statsCard('folder', count, 'Buckets', 'Managed inside projects')}${statsCard('harddrive', bytesHuman(state.objects.reduce((n, x) => n + x.size, 0)), 'Demo object usage', 'Metadata only, no file bytes stored')}</div><div class="grid two">${all.map((s) => `<article class="card clickable" data-action="openService" data-id="${s.id}"><div class="row space"><span class="status-icon mint">${ico('harddrive', 20)}</span>${statusBadge(s.status)}</div><h3 style="margin:17px 0 6px">${esc(s.name)}</h3><p class="muted small">${esc(project(s.projectId)?.name || 'Project')} · ${esc(s.provider || 'Object Storage')}</p><div class="divider"></div><div class="row space"><span class="muted xs">${bucketsFor(s.id).length} buckets · ${bytesHuman(storageTotal(s.id))}</span>${ico('arrow', 17)}</div></article>`).join('') || '<div class="card empty">No storage services yet.</div>'}</div><p class="hint" style="margin-top:19px">This is a storage management simulation. File selections are recorded as metadata; no upload takes place.</p>`;
}

function storageServiceView(s: ServiceRec): string {
  const p = project(s.projectId);
  const tabs = [['overview', 'Overview'], ['buckets', 'Buckets'], ['files', 'Files'], ['access', 'Access'], ['usage', 'Usage'], ['settings', 'Settings']];
  return `<button class="back" data-action="openProject" data-id="${s.projectId}">${ico('back', 15)} ${esc(p?.name || 'Project')}</button>${heading('STORAGE / PRODUCTION', s.name, `${esc(s.provider || 'External storage')} · ${esc(p?.name || 'Project')} · No host filesystem access`, ui.tab === 'buckets' ? btn(`${ico('plus', 15)} New bucket`, 'openModal', 'btn-primary', 'data-modal="bucketCreate"') : ui.tab === 'files' ? btn(`${ico('upload', 15)} Upload file`, 'openModal', 'btn-primary', 'data-modal="objectUpload"') : '')}<div class="tabs">${tabs.map(([k, t]) => `<button class="tab ${ui.tab === k ? 'active' : ''}" data-action="serviceTab" data-tab="${k}">${t}</button>`).join('')}</div>${ui.tab === 'overview' ? storageServiceOverview(s) : ui.tab === 'buckets' ? storageBucketsView(s) : ui.tab === 'files' ? storageFilesView(s) : ui.tab === 'access' ? storageAccessView(s) : ui.tab === 'usage' ? storageUsageView(s) : storageSettingsView(s)}`;
}

function storageServiceOverview(s: ServiceRec): string {
  return `${storageBanner()}<div class="grid three" style="margin-bottom:16px">${statsCard('folder', bucketsFor(s.id).length, 'Buckets', 'Private by default')}${statsCard('file', bucketsFor(s.id).reduce((n, b) => n + objectsFor(b.id).filter((o) => !o.isFolder).length, 0), 'Objects', 'Synthetic objects / metadata')}${statsCard('harddrive', bytesHuman(storageTotal(s.id)), 'Used in demo', 'Storage bytes are not uploaded')}</div><div class="store-grid"><div class="card"><div class="row space"><h3 class="section-title">Storage buckets</h3>${btn('See all buckets', 'serviceTab', 'btn-small', 'data-tab="buckets"')}</div><div class="divider"></div>${bucketsFor(s.id).map((b) => `<div class="storage-attach"><div class="row"><span class="status-icon gold">${ico('folder', 17)}</span><div><strong class="small">${esc(b.name)}</strong><div class="detail">${esc(b.purpose || 'Managed object storage')} · ${objectsFor(b.id).filter((o) => !o.isFolder).length} files</div></div></div><div class="row">${badge(b.privacy === 'private' ? 'Private' : 'Restricted', b.privacy === 'private' ? 'ok' : 'blue')}${btn('Browse', 'storageOpenBucket', 'btn-small', `data-id="${b.id}"`)}</div></div>`).join('') || '<p class="muted">No buckets yet.</p>'}</div><div class="col" style="gap:16px"><div class="card"><h3 class="section-title">Production connection</h3><p class="muted small">Use an external S3-compatible provider for small VPS installations. The platform controls access through resource-bound credentials.</p><div class="divider"></div><div class="kv"><span class="k">Provider</span><span class="v">${esc(s.provider)}</span><span class="k">Credentials</span><span class="v">Not connected · demo</span><span class="k">Data path</span><span class="v">Bucket/object key</span></div></div><div class="card"><h3 class="section-title">Maid Finder example</h3><p class="muted small">KYC ID front/back and selfie remain private. Profile photos use a separate bucket. The Express API authorizes temporary upload/read URLs.</p>${btn('View access rules', 'serviceTab', 'btn-small', 'data-tab="access"')}</div></div></div>`;
}

function storageBucketsView(s: ServiceRec): string {
  return `<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Buckets</h3><p class="muted xs">Buckets are resources, not server directories. New buckets start private.</p></div>${btn(`${ico('plus', 15)} Create bucket`, 'openModal', 'btn-primary', 'data-modal="bucketCreate"')}</div><div class="grid two">${bucketsFor(s.id).map((b) => `<article class="card store-card" data-action="storageOpenBucket" data-id="${b.id}"><div class="row space"><span class="status-icon gold">${ico('folder', 20)}</span>${badge(b.privacy === 'private' ? 'Private' : 'Restricted', b.privacy === 'private' ? 'ok' : 'blue')}</div><div class="name mono" style="margin-top:15px">${esc(b.name)}</div><p>${esc(b.purpose || 'Application objects')}</p><div class="divider"></div><div class="row space"><span class="muted xs">${objectsFor(b.id).filter((o) => !o.isFolder).length} files · ${bytesHuman(totalBytes(b.id))}</span>${btn('Browse files →', 'storageOpenBucket', 'btn-small', `data-id="${b.id}"`)}</div></article>`).join('') || '<div class="card empty">Create your first private bucket.</div>'}</div><p class="hint">In production, quotas, ownership, provider credentials, and encryption policies are enforced by backend services, not browser code.</p>`;
}

function storageFilesView(s: ServiceRec): string {
  const bs = bucketsFor(s.id);
  const selected = bs.find((b) => b.id === ui.storageBucketId) || bs[0];
  if (!selected) return `<div class="card empty"><h3>No buckets yet</h3>${btn('Create bucket', 'openModal', 'btn-primary', 'data-modal="bucketCreate"')}</div>`;
  ui.storageBucketId = selected.id;
  const prefix = String(ui.storagePrefix || '');
  const search = String(ui.storageSearch || '').toLowerCase();
  const contents = objectsFor(selected.id).filter((o) => o.key.startsWith(prefix));
  const folderNames = new Set<string>();
  const files: ObjectRec[] = [];
  for (const o of contents) {
    const rest = o.key.slice(prefix.length);
    if (!rest) continue;
    const n = rest.indexOf('/');
    if (n >= 0) folderNames.add(rest.slice(0, n) + '/');
    else if (!o.isFolder) files.push(o);
  }
  let folders = [...folderNames].sort().filter((x) => !search || x.toLowerCase().includes(search));
  const shownFiles = files.filter((x) => !search || x.key.toLowerCase().includes(search)).sort((a, b) => a.key.localeCompare(b.key));
  void folders; void shownFiles;
  return `${storageBanner()}<div class="card" style="margin-bottom:16px"><div class="row space" style="flex-wrap:wrap"><div><h3 class="section-title">Object explorer</h3><p class="muted xs">File manager is scoped to a single bucket and prefix.</p></div><div class="row" style="flex-wrap:wrap">${btn(`${ico('folder', 14)} New folder`, 'openModal', 'btn-small', 'data-modal="storageFolder"')}${btn(`${ico('upload', 14)} Upload`, 'openModal', 'btn-primary', 'data-modal="objectUpload"')}</div></div><div class="row" style="gap:13px;margin-top:17px;flex-wrap:wrap"><label class="form-label" for="storageBucketSelect">Bucket</label><select id="storageBucketSelect" style="max-width:360px">${bs.map((b) => `<option value="${b.id}" ${selected.id === b.id ? 'selected' : ''}>${esc(b.name)} · ${b.privacy === 'private' ? 'Private' : 'Restricted'}</option>`).join('')}</select></div><div class="row space" style="margin-top:15px;flex-wrap:wrap;gap:11px"><div class="file-crumb">${ico('folderopen', 17)}<button data-action="storagePrefix" data-prefix="">${esc(selected.name)}</button>${prefix.split('/').filter(Boolean).map((part, i, arr) => `${ico('chevron', 12)}<button data-action="storagePrefix" data-prefix="${attr(arr.slice(0, i + 1).join('/') + '/')}">${esc(part)}</button>`).join('')}</div><div class="search" style="max-width:260px">${ico('search', 15)}<input id="storageSearch" value="${attr(ui.storageSearch)}" placeholder="Filter files…" aria-label="Filter bucket files"></div></div></div><div class="card table-frame storage-explorer">${folders.map((name) => `<div class="file-row file-folder" data-action="storagePrefix" data-prefix="${attr(prefix + name)}"><span class="status-icon gold">${ico('folderopen', 18)}</span><div style="flex:1"><div class="file-name mono">${esc(name)}</div><div class="file-meta">Virtual prefix · only objects in this bucket</div></div><span style="color:var(--muted)">${ico('chevron', 15)}</span></div>`).join('')}${shownFiles.map((o) => `<div class="file-row"><span class="status-icon ${o.type.startsWith('image/') ? 'mint' : ''}">${ico(o.type.startsWith('image/') ? 'image' : 'file', 17)}</span><div style="flex:1;min-width:130px"><div class="file-name mono">${esc(o.key.slice(prefix.length))}</div><div class="file-meta">${bytesHuman(o.size)} · ${esc(o.type)} · ${date(o.created)}</div></div><div class="file-actions">${badge(selected.privacy === 'private' ? 'Private' : 'Restricted', 'blue')}${btn('Details', 'storageInspect', 'btn-small', `data-id="${o.id}"`)}${btn('Remove', 'storageDeleteObject', 'btn-small', `data-id="${o.id}"`)}</div></div>`).join('')}${folders.length + shownFiles.length === 0 ? '<div class="storage-empty">No objects in this location. Upload a file to create demo metadata.</div>' : ''}</div><p class="hint">Demo uploads save only name, MIME type, and size metadata. Original file bytes are never uploaded or stored here. No real preview or download is provided.</p>`;
}

function storageAccessView(s: ServiceRec): string {
  const apps = state.services.filter((a) => a.projectId === s.projectId && a.kind === 'application');
  void apps;
  return `${storageBanner()}<div class="store-grid"><div class="card"><div class="row space"><div><h3 class="section-title">Application access</h3><p class="muted xs">Allow a specific application to use a specific bucket.</p></div>${btn(`${ico('plus', 14)} Grant access`, 'openModal', 'btn-primary', 'data-modal="storageGrant"')}</div><div class="divider"></div>${grantsFor(s.id).map((g) => {
    const a = service(g.serviceId), b = bucket(g.bucketId);
    return `<div class="storage-attach"><div><strong class="small">${esc(a?.name || 'Deleted application')}</strong><div class="detail mono">${esc(b?.name || 'Deleted bucket')}</div><span class="access-scope">${esc(g.scope)}</span></div>${btn('Revoke', 'storageRevokeGrant', 'btn-small', `data-id="${g.id}"`)}</div>`;
  }).join('') || '<div class="storage-empty">No connected applications. Grant a scoped connection to start.</div>'}<p class="hint">These are visual grants only. Production must use short-lived, bucket-restricted storage credentials and audited operations.</p></div><div class="col" style="gap:16px"><div class="card"><h3 class="section-title">Signed URLs</h3><p class="muted small">Your application authenticates users, validates object ownership, and issues short-lived upload/download URLs with restricted methods and size limits.</p>${badge('No real URLs or secrets generated', 'warn')}</div><div class="card"><h3 class="section-title">Privacy safeguards</h3><p class="muted small">Private default · encryption · no public KYC links · retention rules · audit log · anti-malware screening and content-type validation.</p></div></div></div>`;
}

function storageUsageView(s: ServiceRec): string {
  const bs = bucketsFor(s.id);
  return `<div class="grid three" style="margin-bottom:18px">${statsCard('harddrive', bytesHuman(storageTotal(s.id)), 'Synthetic total', 'Object metadata only')}${statsCard('folder', bs.length, 'Buckets', 'No OS filesystem paths')}${statsCard('file', bs.reduce((n, b) => n + objectsFor(b.id).filter((o) => !o.isFolder).length, 0), 'Objects', 'No real uploads')}</div><div class="card"><h3 class="section-title">Bucket usage and quotas</h3><p class="muted xs">Quotas are design previews only; no backend is enforcing them yet.</p><div class="divider"></div>${bs.map((b) => {
    const used = totalBytes(b.id), max = b.maxMB * 1048576, pct = Math.min(100, 100 * used / max);
    return `<div style="margin:15px 0"><div class="row space"><strong class="small mono">${esc(b.name)}</strong><span class="muted xs">${bytesHuman(used)} of ${b.maxMB} MB</span></div><div class="progress" style="margin:8px 0"><span style="width:${Math.max(pct, .3)}%"></span></div></div>`;
  }).join('')}</div><p class="hint">1 GB RAM / 10 GB disk is a control-plane design target. Prefer external S3-compatible storage; self-hosted object storage needs additional capacity and separate backup planning.</p>`;
}

function storageSettingsView(s: ServiceRec): string {
  return `<div class="grid two"><div class="card"><h3 class="section-title">Storage settings</h3><div class="divider"></div><div class="kv"><span class="k">Name</span><span class="v mono">${esc(s.name)}</span><span class="k">Provider</span><span class="v">${esc(s.provider)}</span><span class="k">Deployment</span><span class="v">External integration (simulated)</span><span class="k">Data reference</span><span class="v">Bucket + object key</span><span class="k">Host filesystem</span><span class="v">Never exposed</span></div></div><div class="card"><h3 class="section-title">Provider integration</h3><p class="muted small">In production, connect a provider through a scoped integration with encrypted credentials. Bucket operations use Cloudlane's permission-checked API, never client-side master keys.</p><div class="divider"></div>${badge('Connection not configured · demo', 'warn')}<div style="margin-top:16px">${btn('Review integrations', 'settingsTab', '', 'data-tab="integrations" data-from-storage="true"')}</div></div></div>`;
}

function appArtifactsView(s: ServiceRec): string {
  const d = deploymentsFor(s.id)[0];
  const names = s.framework === 'Static HTML' ? ['index.html', 'assets/', 'styles.css']
    : s.framework === 'Next.js' ? ['package.json', 'next.config.js', 'app/', '.next/ (build output)']
    : s.framework === 'React/Vite' ? ['package.json', 'src/', 'dist/']
    : ['package.json', 'src/', 'dist/', 'node_modules/'];
  return `${storageBanner()}<div class="grid two-wide"><div class="card"><div class="row space"><h3 class="section-title">Deployment artifacts</h3>${badge('Read-only', 'blue')}</div><p class="muted small">Illustrative artifact manifest from the latest release; no actual source contents are loaded.</p><div class="divider"></div>${names.map((n) => `<div class="file-row" style="padding:12px 0"><span class="status-icon">${ico(n.endsWith('/') ? 'folder' : 'file', 15)}</span><span class="mono small">${esc(n)}</span><span style="margin-left:auto" class="muted xs">${n.endsWith('/') ? 'Directory' : 'File'}</span></div>`).join('')}</div><div class="card"><h3 class="section-title">Immutable application release</h3><div class="kv"><span class="k">Release</span><span class="v mono">${esc(d?.revision || 'Pending')}</span><span class="k">Source</span><span class="v">${esc(s.source === 'github' ? 'GitHub' : 'ZIP Upload')}</span><span class="k">Editing</span><span class="v">Disabled</span><span class="k">Changes</span><span class="v">Deploy a new release</span></div><div class="divider"></div>${btn('View deployments', 'serviceTab', '', 'data-tab="deployments"')}<p class="hint">This is not a live filesystem explorer. Changes must use the deployment pipeline.</p></div></div>`;
}

function appVolumesView(s: ServiceRec): string {
  const vols = state.volumes.filter((v) => v.serviceId === s.id);
  return `${storageBanner()}<div class="row space" style="margin-bottom:16px"><div><h3 class="section-title">Persistent volumes</h3><p class="muted xs">Managed allocations for stateful application data. Separate from object storage and deployment files.</p></div>${btn(`${ico('plus', 15)} Allocate volume`, 'openModal', 'btn-primary', 'data-modal="volumeCreate"')}</div><div class="card">${vols.length ? vols.map((v) => `<div class="storage-attach"><div class="row"><span class="status-icon">${ico('disk', 19)}</span><div><strong class="small">${esc(v.name)}</strong><div class="detail mono">Container mount: ${esc(v.mount)} · ${v.quotaMB} MB limit</div></div></div>${badge('Allocated', 'ok')}</div>`).join('') : '<div class="storage-empty">No persistent volumes attached to this application.</div>'}</div><div class="storage-tip" style="margin-top:16px">Volumes are never exposed as host OS paths. No arbitrary bind mounts. Real volume deletion and backup require explicit retention safeguards.</div>`;
}

function docsView(): string {
  return `${heading('DEVELOPER REFERENCE', 'Documentation', 'An implementation-oriented preview of Cloudlane developer tools.')}
 <div class="soft-banner" style="margin-bottom:19px">${ico('info', 20)}<div><strong class="small">Architecture specification, not a running HTTP API</strong><p>This page is an interactive documentation preview; no public endpoints or credentials exist yet.</p></div></div>
 <div class="grid two-wide"><div class="card"><h3 class="section-title">API principles</h3><div class="divider"></div><div class="col" style="gap:10px"><div>${badge('REST /api/v1', 'blue')} ${badge('Bearer tokens', 'blue')}</div><p class="muted small">Versioned endpoints, workspace-scoped authorization, idempotency keys for provisioning, and audit events.</p><div class="docs-code">GET    /api/v1/projects\nPOST   /api/v1/projects\nPOST   /api/v1/deployments\nGET    /api/v1/domains\nPOST   /api/v1/databases\nPOST   /api/v1/cron-jobs</div>${btn('Manage demo API keys', 'settingsTab', '', 'data-tab="api" data-from-docs="true"')}</div></div><div class="card"><h3 class="section-title">Our five product principles</h3><div class="divider"></div><div class="col" style="gap:14px">${[['AI-native management', 'Guided diagnosis and permission-checked plans'], ['Unified workspace', 'One project model and shared resources'], ['Zero-friction deployments', 'ZIP and GitHub share a single pipeline'], ['Self-healing infrastructure', 'Health checks, safe restarts, rollback and alerts'], ['Expandable by design', 'From one VPS to multiple agents and teams']].map(([a, b], i) => `<div class="row" style="align-items:flex-start"><span class="status-icon mint">${i + 1}</span><div><strong class="small">${a}</strong><div class="muted xs">${b}</div></div></div>`).join('')}</div></div></div>
 <div class="card" style="margin-top:17px"><div class="row">${ico('terminal', 20)}<h3 class="section-title">Terminal and SSH boundaries</h3></div><div class="divider"></div><p class="muted small">Application terminals run only inside their authorized containers, and database consoles are distinct read-only previews. Server SSH belongs to external administrators. Cloudlane API tokens authorize API scopes only; they are never operating-system login credentials.</p><div class="row" style="margin-top:15px">${btn('Server access policy', 'settingsTab', '', 'data-tab="server" data-from-docs="true"')}${btn('Security settings', 'settingsTab', '', 'data-tab="security" data-from-docs="true"')}</div></div>
 <div class="card" style="margin-top:17px"><h3 class="section-title">Object Storage and file boundaries</h3><div class="divider"></div><div class="safety-split"><div class="safety-unit">${ico('code', 20)}<h3>Deployment artifacts</h3><p>Inspect a synthetic manifest. Production files remain immutable and change through new releases.</p></div><div class="safety-unit">${ico('bucket', 20)}<h3>Objects and buckets</h3><p>Media and KYC stored under bucket IDs and object keys. Never expose host paths.</p></div><div class="safety-unit">${ico('disk', 20)}<h3>Persistent volumes</h3><p>Explicit named allocations, restricted container mount points and independent backups.</p></div></div><p class="hint">API concepts: /api/v1/storage, /buckets, /objects, /grants and /volumes.</p></div>`;
}

function aiSuggestions(): string[] {
  if (ui.page === 'service') {
    const s = service(ui.serviceId);
    return [`Explain the latest logs for ${s?.name || 'this service'}`, `Check health and recovery options for ${s?.name || 'this service'}`];
  }
  if (ui.page === 'project') {
    const p = project(ui.projectId);
    return [`Check the health and dependencies of ${p?.name || 'this project'}`, 'Connect an API to a PostgreSQL database'];
  }
  return ['Deploy my backend with PostgreSQL and a domain', 'Diagnose a failed deployment and suggest safe recovery'];
}

function aiCreatePlan(prompt: string): { prompt: string; summary: string; steps: string[]; progress: number; approved: boolean; complete: boolean } {
  const t = prompt.toLowerCase();
  let steps: string[] = [];
  let summary = 'Guided infrastructure action plan';
  if (/\b(storage|bucket|kyc|media|object storage|profile photos)\b/i.test(t)) {
    return { prompt, summary: 'Private object storage configuration plan', steps: ['Identify the workspace project and existing storage service', 'Confirm provider and private bucket configuration', 'Validate scoped application access, encryption and upload constraints', 'Review retention, quota and audit requirements', 'Request approval before applying any future live changes'], progress: -1, approved: false, complete: false };
  }
  if (/log|fail|debug|diagnos|health|error|recover|restart|rollback/.test(t)) {
    summary = 'Diagnostic and safe recovery plan';
    steps = ['Inspect the selected service and latest deployment logs', 'Compare build, startup, and health-check signals', 'Explain the most likely failure and present evidence', 'Propose a limited restart or healthy-release rollback for approval'];
  } else if (/deploy|application|app|github|backend|api|zip|laravel|next/.test(t)) {
    summary = 'Application deployment plan';
    steps = ['Review ZIP or GitHub source and detect framework', 'Validate runtime, required environment variables, and resource limits'];
    if (/postgres|mysql|database/.test(t)) steps.push('Provision and privately connect the requested database');
    steps.push('Build in an isolated environment and start candidate release', 'Run health checks before activating the HTTPS endpoint');
    if (/domain|ssl|https/.test(t)) steps.push('Verify an available hostname in the central Domains registry and activate TLS');
    if (/laravel/.test(t)) steps.splice(1, 0, 'Confirm Laravel build support (not in current MVP) before proceeding');
  } else if (/domain|dns|ssl|certificate/.test(t)) {
    summary = 'Domain and HTTPS configuration plan';
    steps = ['Check domain registration and ownership verification', 'Inspect DNS records and available hostnames', 'Confirm application binding without a routing conflict', 'Request or validate automatic TLS certificate'];
  } else if (/cron|schedul/.test(t)) {
    summary = 'Scheduled task plan';
    steps = ['Validate the target HTTPS endpoint and auth requirements', 'Check timezone, cron expression, timeout, and retry settings', 'Request approval before enabling the schedule', 'Verify execution history and failure alerts'];
  } else {
    steps = ['Inspect the current workspace context', 'Validate supported actions and required permissions', 'Present a scoped execution plan for approval'];
  }
  return { prompt, summary, steps, progress: -1, approved: false, complete: false };
}

function assistantPane(): string {
  if (!ui.assistantOpen) return '';
  const p = ui.assistantPlan as { summary: string; steps: string[]; progress: number; approved: boolean; complete: boolean } | null;
  return `<div class="ai-overlay" data-action="assistantClose" aria-hidden="true"></div><aside class="ai-drawer" role="dialog" aria-modal="true" aria-label="Cloudlane assistant"><div class="ai-drawer-head"><span class="status-icon mint">${ico('sparkles', 19)}</span><div style="flex:1"><strong>Cloudlane Assistant</strong><div class="muted xs">Guided operations · demonstration</div></div><button class="icon-btn" data-action="assistantClose" aria-label="Close assistant">${ico('close', 17)}</button></div><div class="ai-body"><div class="ai-safety">${ico('shield', 16)} This is a rule-based prototype, not a live AI model. Plans and execution are simulated; approval does not change real infrastructure.</div><div class="col" style="gap:7px"><strong class="small">Try a prompt</strong>${aiSuggestions().map((x) => `<button class="ai-sample" data-action="assistantPrompt" data-prompt="${attr(x)}">${esc(x)}</button>`).join('')}</div><form id="assistantForm" class="ai-input-area"><label class="form-label" for="assistantQuery">What would you like Cloudlane to do?</label><textarea id="assistantQuery" name="query" required maxlength="400" placeholder="e.g. Explain why my NestJS API failed to deploy">${esc(String(ui.assistantText || ''))}</textarea><button class="btn btn-primary" type="submit">${ico('sparkles', 15)} Generate plan</button></form>${p ? `<div class="card"><div class="row space"><div><h3 class="section-title">${esc(p.summary)}</h3><p class="muted xs">Proposed steps · review before approval</p></div>${badge(p.complete ? 'Simulated complete' : p.approved ? 'Running demo' : 'Needs approval', p.complete ? 'ok' : p.approved ? 'blue' : 'warn')}</div><div class="divider"></div>${p.steps.map((step, i) => `<div class="ai-plan-step ${p.progress >= i ? 'done' : ''}"><span class="ai-step-no">${p.progress >= i ? ico('check', 12) : i + 1}</span><span>${esc(step)}</span></div>`).join('')}${p.complete ? '<p class="hint">Demo finished. Only an activity event was recorded; no real resources were provisioned.</p>' : p.approved ? '<p class="hint">Executing simulated operations…</p>' : `<div class="row" style="margin-top:16px">${btn('Approve & simulate', 'assistantApprove', 'btn-primary')}${btn('Discard', 'assistantDiscard')}</div>`}</div>` : ''}<p class="muted xs">Production design: least-privilege tools, audit trails, explicit approval for changes, and no unrestricted shell access.</p></div></aside>`;
}

function settingsNavigation(): string {
  return `<div class="tabs settings-nav">${[['workspace', 'Workspace'], ['integrations', 'Integrations'], ['api', 'API Keys'], ['security', 'Security'], ['server', 'Server'], ['preferences', 'Preferences']].map(([id, name]) => `<button class="tab ${ui.settingsTab === id ? 'active' : ''}" data-action="settingsTab" data-tab="${id}">${name}</button>`).join('')}</div>`;
}

function settingsView(): string {
  const tabs = settingsNavigation();
  const lead = heading('CONFIGURATION', 'Settings', 'Connections, security, developer access and platform preferences.');
  if (ui.settingsTab === 'workspace')
    return `${heading('CONFIGURATION', 'Settings', 'Manage your workspace and your Cloudlane installation.', '')}${tabs}<div class="grid two"><div class="card"><h3 class="section-title">Workspace</h3><p class="muted small">Your current workspace name</p><form id="workspaceForm"><div class="form-row"><label class="form-label" for="workspaceName">Workspace name</label><input id="workspaceName" name="workspace" maxlength="54" value="${attr(state.workspace)}" required></div><button class="btn btn-primary" type="submit">Save changes</button></form></div><div class="card"><h3 class="section-title">GitHub connection</h3><p class="muted small">Connect repositories via a GitHub App. This demo only simulates authorization.</p><div class="row space" style="margin-top:22px"><div class="row">${ico('github', 20)}<strong>${state.githubConnected ? 'Demo account connected' : 'Not connected'}</strong></div>${btn(state.githubConnected ? 'Disconnect demo' : 'Connect demo', 'toggleGithub', state.githubConnected ? '' : 'btn-primary')}</div></div><div class="card"><h3 class="section-title">Sample workspace</h3><p class="muted small">Your workspace was seeded with a sample portfolio of projects so you can explore every screen. Resetting restores that sample and removes your local changes.</p><div class="divider"></div>${btn(`${ico('refresh', 15)} Reset sample workspace`, 'resetPrompt', 'btn-danger')}</div><div class="card"><h3 class="section-title">Scope</h3><p class="muted small">ZIP, GitHub, application hosting, database provisioning, cron jobs, domains, deployment logs, rollback, and resource monitoring are represented.</p><div class="divider"></div><div class="pills">${badge('Single VPS', 'blue')}${badge('Agent-wired', 'blue')}${badge('Mobile distribution: later', 'warn')}</div></div></div>`;
  if (ui.settingsTab === 'integrations') return lead + tabs +
    `<div class="setting-grid"><div class="card setting-feature"><div class="row space"><div class="row">${ico('github', 21)}<h3 class="section-title">GitHub</h3></div>${badge(state.githubConnected ? 'Connected (demo)' : 'Not connected', state.githubConnected ? 'ok' : 'warn')}</div><p class="muted small">Repository selection and push-triggered deployments. Production uses a GitHub App with least-privilege permissions.</p>${btn(state.githubConnected ? 'Disconnect demo GitHub' : 'Connect demo GitHub', 'toggleGithub', state.githubConnected ? '' : 'btn-primary')}</div><div class="card setting-feature"><div class="row">${ico('globe', 21)}<h3 class="section-title">DNS management</h3></div><p class="muted small">Use Manual DNS or Cloudlane Managed DNS per domain. No registrar API integration is required. Managed mode needs independent authoritative DNS infrastructure in production.</p>${badge('Two DNS modes', 'blue')}<button class="btn" data-action="go" data-page="domains">Go to domains</button></div><div class="card setting-feature"><div class="row">${ico('mail', 21)}<h3 class="section-title">Email providers</h3></div><p class="muted small">SMTP and mail-provider integrations are a future production option for lightweight VPS installations.</p>${badge('Planned integration', 'blue')}</div><div class="card setting-feature"><div class="row space"><div class="row">${ico('bucket', 21)}<h3 class="section-title">S3-compatible object storage</h3></div>${badge('Integration planned', 'blue')}</div><p class="muted small" style="margin-top:9px">Cloudlane can manage private buckets using provider-scoped credentials. This prototype never collects or connects real credentials; use Projects → Storage to explore the resource model.</p>${btn('Explore demo storage', 'storageIndex', 'btn-small')}</div><div class="card setting-feature"><div class="row">${ico('connections', 21)}<h3 class="section-title">Connection principles</h3></div><p class="muted small">Each integration has scoped permissions, separate credentials, and a revocation path. Do not reuse platform API keys as third-party credentials.</p></div></div>`;
  if (ui.settingsTab === 'api') return lead + tabs +
    `<div class="card"><div class="row space"><div><h3 class="section-title">Platform API keys</h3><p class="muted small">For external scripts and automation that will call Cloudlane. All keys here are nonfunctional demo examples.</p></div>${btn(`${ico('plus', 15)} Generate demo key`, 'openApiKey', 'btn-primary')}</div>${ui.revealedKey ? `<div class="soft-banner" style="margin:18px 0">${ico('key', 20)}<div><strong class="small">Copy this example key now</strong><p class="muted xs">Displayed only until dismissed. It does not authenticate anywhere.</p><div class="token-preview">${esc(String(ui.revealedKey))}</div><div class="row" style="margin-top:10px">${btn('Copy demo key', 'copy', 'btn-small', `data-copy="${attr(ui.revealedKey)}"`)}${btn('Dismiss', 'dismissKey', 'btn-small')}</div></div></div>` : ''}<div class="divider"></div><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Scope</th><th>Created</th><th>Status</th><th>Action</th></tr></thead><tbody>${state.apiKeys.map((k) => `<tr><td class="main-cell">${esc(k.name)}<div class="muted xs mono">••••${esc(k.last4)}</div></td><td>${esc(k.scope)}</td><td>${date(k.created)}</td><td>${badge(k.revoked ? 'Revoked' : 'Demo active', k.revoked ? 'warn' : 'ok')}</td><td>${k.revoked ? '—' : btn('Revoke', 'revokeApiKey', 'btn-small', `data-id="${k.id}"`)}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">No demo API keys yet.</div></td></tr>'}</tbody></table></div></div><div class="soft-banner" style="margin-top:16px">${ico('book', 20)}<div><strong class="small">API documentation</strong><p>Explore the proposed /api/v1 endpoints, scopes and example requests.</p></div>${btn('Open docs →', 'openDocs', 'btn-small')}</div>`;
  if (ui.settingsTab === 'security') return lead + tabs +
    `<div class="setting-grid"><div class="card"><h3 class="section-title">Authorization model</h3><div class="divider"></div><p class="muted small">Workspace ownership, per-project membership, scoped service operations, and approval gates for destructive actions.</p><p class="hint">The demo uses one simulated administrator. Real RBAC and multiuser sessions are not implemented.</p></div><div class="card"><h3 class="section-title">Audit trail</h3><div class="divider"></div><p class="muted small">Service actions, domain changes, database grants, and AI plan approvals must be auditable.</p>${btn('View activity & logs', 'go', '', 'data-page="activity"')}</div><div class="card"><div class="row">${ico('terminal', 20)}<h3 class="section-title">Terminal access policy</h3></div><div class="divider"></div><div class="access-list"><div>${badge('Viewer', 'warn')} Application terminal denied</div><div>${badge('Developer', 'blue')} Container-scoped sessions only</div><div>${badge('Admin', 'ok')} Maintenance rights still require separate approval</div><div>${ico('shield', 15)} No terminal from platform API keys</div><div>${ico('shield', 15)} Never grant AI unrestricted shell execution</div></div><p class="hint">The role selector inside the terminal is a demonstration switch, not real authorization.</p></div></div>`;
  if (ui.settingsTab === 'server') return lead + tabs +
    `<div class="setting-grid"><div class="card"><h3 class="section-title">Registered server</h3><div class="divider"></div><div class="kv"><span class="k">Name</span><span class="v mono">${esc(state.server.name)}</span><span class="k">System</span><span class="v">${esc(state.server.os)}</span><span class="k">Resources</span><span class="v">1 vCPU · 1 GB RAM · 10 GB disk</span></div><div class="divider"></div>${btn('Open server health', 'go', '', 'data-page="servers"')}</div><div class="card"><h3 class="section-title">Lightweight operating mode</h3><p class="muted small">PostgreSQL + pg-boss for platform jobs, Caddy for HTTPS, optional external builds, restricted workload concurrency and disk quotas.</p>${badge('1 GB baseline · design target', 'blue')}<p class="hint">Not benchmarked or validated on a live VPS in this HTML prototype.</p></div><div class="card"><div class="row space"><div class="row">${ico('key', 21)}<h3 class="section-title">Advanced SSH access</h3></div>${badge('Administrator only', 'warn')}</div><p class="muted small" style="margin:11px 0">SSH is for host maintenance and recovery. Cloudlane does not provide a VPS browser terminal, enable SSH, or store private keys.</p><div class="divider"></div><div class="kv"><span class="k">Access method</span><span class="v">External SSH client</span><span class="k">Authentication</span><span class="v">Administrator-managed public key</span><span class="k">Cloudlane API keys</span><span class="v">Never valid for SSH</span></div><p class="muted xs" style="margin:17px 0 7px">Documentation-only example (reserved test IP)</p><div class="row" style="gap:9px;flex-wrap:wrap"><code class="mono" style="background:#08131c;padding:9px 11px;border-radius:7px;overflow-wrap:anywhere">ssh cloudadmin@203.0.113.42</code>${btn(`${ico('copy', 14)} Copy example`, 'copy', 'btn-small', 'data-copy="ssh cloudadmin@203.0.113.42"')}</div><div class="notice" style="margin-top:15px">This address is only an example—not your VPS. Configure SSH through your hosting provider, prefer key-only login, and retain provider console access for recovery.</div></div></div>`;
  // preferences
  return lead + tabs + appearancePanel() +
    `<div class="setting-grid"><div class="card"><h3 class="section-title">Design direction</h3><p class="muted small">Simple defaults, progressive disclosure, and contextual actions. Keep Projects, Domains, Databases, Email and Cron Jobs accessible from the main sidebar.</p></div><div class="card"><h3 class="section-title">Planned capabilities</h3><p class="muted small">Project-scoped file manager, stronger recovery automation, multi-server agents, teams and reseller features will be added in phases.</p>${badge('Roadmap · not yet functional', 'blue')}</div></div>`;
}
/* ── modals — verbatim from the prototype (final merged layer) ── */

function openModal(type: string, extra: Record<string, unknown> = {}): void {
  const allowed = ['new', 'project', 'deploy', 'database', 'cron', 'domainAttach', 'domainRegister',
    'subdomain', 'dnsRecord', 'verifyZone', 'mailbox', 'mailAlias', 'demoInbox', 'variable',
    'dbAccess', 'reset', 'dns', 'dbAdmin', 'dbUserAdd', 'dbUserManage', 'dbUserPrivileges',
    'apiKeyCreate', 'storageCreate', 'bucketCreate', 'storageFolder', 'objectUpload',
    'storageGrant', 'volumeCreate', 'storageInspect', 'dnsModeChange'];
  if (!allowed.includes(type)) return;
  ui.modal = type;
  ui.modalData = {
    projectId: (extra.projectId as string) || (ui.projectId as string) || state.projects[0]?.id || '__new__',
    serviceId: (extra.serviceId as string) || '',
    zoneId: (extra.zoneId as string) || (ui.domainZoneId as string) || '',
    source: 'zip',
    ...extra,
  };
  render();
}

function modalView(): string {
  const type = ui.modal as string;
  const info = ({
    new: ['Create something new', 'Choose what you want to run on your infrastructure.'],
    project: ['Create project', 'A project groups environments, applications and services.'],
    deploy: ['Deploy application', 'Use a ZIP archive or a GitHub repository.'],
    database: ['Provision database', 'Create a standalone database for any application.'],
    cron: ['Create cron job', 'Schedule an HTTP callback independently of your app.'],
    domainAttach: ['Connect registered domain', 'Choose an available hostname from your verified domains.'],
    domainRegister: ['Add domain', 'Enter your domain now. Configure DNS afterward under Manage → Settings.'],
    subdomain: ['Create subdomain', 'Add a new hostname to this domain.'],
    dnsRecord: ['DNS record', 'Edit simulated DNS records in the central registry.'],
    verifyZone: ['Verify domain ownership', 'Simulate ownership verification after configuring your DNS provider.'],
    mailbox: ['Create mailbox', 'Provision a simulated email account for this domain.'],
    mailAlias: ['Create email alias', 'Forward email from an alias to an existing mailbox.'],
    demoInbox: ['Demo webmail', 'Preview a sample inbox without sending or receiving real mail.'],
    variable: ['Add environment variable', 'Secure configuration belongs to an individual service.'],
    dbAccess: ['Database network access', 'Restrict which external addresses can connect.'],
    dbAdmin: ['Database administration', 'Open the admin tool signed in as the database user.'],
    dbUserAdd: ['Add database user', 'Create a dedicated user with scoped privileges.'],
    dbUserManage: ['Manage database user', 'Account details and access controls.'],
    dbUserPrivileges: ['User privileges', 'Choose what this database user is allowed to do.'],
    reset: ['Reset prototype data', 'Restore the sample workspace and remove local changes.'],
    dns: ['Domain DNS instructions', 'Configure the required records before activating HTTPS.'],
    apiKeyCreate: ['Generate demo API key', 'Design preview: scope and revoke an external automation credential.'],
    storageCreate: ['Create object storage', 'Scoped resource management · simulation'],
    bucketCreate: ['Create storage bucket', 'Scoped resource management · simulation'],
    storageFolder: ['Create virtual folder', 'Scoped resource management · simulation'],
    objectUpload: ['Upload file (demo)', 'Scoped resource management · simulation'],
    storageGrant: ['Grant bucket access', 'Scoped resource management · simulation'],
    volumeCreate: ['Allocate persistent volume', 'Scoped resource management · simulation'],
    storageInspect: ['Object details', 'Scoped resource management · simulation'],
    dnsModeChange: ['Change DNS management', ''],
  } as Record<string, string[]>)[type] || ['Settings', ''];
  let html = '';
  const projOptions = state.projects.map((p) =>
    `<option value="${p.id}" ${((ui.modalData.projectId || ui.projectId) === p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const projectSelection = (ui.modalData.projectId as string) || (ui.projectId as string) || state.projects[0]?.id || '__new__';
  const inlineProject = projectSelection === '__new__';
  const projSelect =
    `<div class="form-row"><label class="form-label" for="projectId">Project</label><select id="projectId" name="projectId" required>${projOptions}<option value="__new__" ${inlineProject ? 'selected' : ''}>+ Create new project</option></select><p class="hint">Every service belongs to a project. Create one here without leaving this form.</p></div><div class="form-row" id="inlineProjectRow" ${inlineProject ? '' : 'hidden'}><label class="form-label" for="newProjectName">New project name</label><input id="newProjectName" name="newProjectName" maxlength="62" placeholder="e.g. Delivery platform" ${inlineProject ? 'required' : ''} value="${attr(ui.modalData.newProjectName || '')}"><p class="hint">A production environment is created automatically.</p></div>`;
  if (type === 'new') {
    html =
      `<div class="tile-options">${[['deploy', 'rocket', 'Application', 'Websites, APIs and workers'], ['database', 'database', 'Database', 'PostgreSQL, MySQL, MariaDB'], ['cron', 'clock', 'Cron Job', 'Scheduled HTTPS callbacks']].map(([t, i, n, d]) => `<button class="tile-option" data-action="newType" data-type="${t}"><span class="status-icon ${t === 'cron' ? 'gold' : 'mint'}">${ico(i, 20)}</span><span><strong>${n}</strong><br><span>${d}</span></span>${ico('chevron', 14)}</button>`).join('')}<button class="tile-option" data-action="newType" data-type="storageCreate"><span class="status-icon gold">${ico('bucket', 20)}</span><span><strong>Object Storage</strong><br><span>Private buckets and media files</span></span>${ico('chevron', 14)}</button></div><p class="hint" style="margin-top:19px">Mobile app build and distribution features are intentionally deferred to a later phase.</p>`;
  }
  if (type === 'project') {
    html =
      `<form id="projectForm"><div class="form-row"><label class="form-label" for="name">Project name</label><input id="name" name="name" required maxlength="62" placeholder="e.g. My delivery app" autofocus><p class="hint">Creates a production environment automatically.</p></div><div class="modal-footer" style="margin:0 -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Create project ${ico('arrow', 15)}</button></div></form>`;
  }
  if (type === 'deploy') {
    const source = (ui.modalData.source as string) || 'zip';
    const detected = (ui.modalData.detected as string) || 'Not detected yet';
    const fn = ui.modalData.fileName as string | undefined;
    html =
      `<form id="deployForm">${projSelect}<div class="form-row"><label class="form-label" for="appname">Service name</label><input id="appname" name="name" required maxlength="48" placeholder="my-app" value="${attr(ui.modalData.name || '')}" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]*" title="Use letters, numbers, hyphens, or underscores" /><p class="hint">We automatically identify the application type and suggest a runtime from its source.</p></div><div class="form-row"><label class="form-label">Source code</label><div class="tile-options"><button type="button" class="tile-option" data-action="source" data-source="zip" style="border-color:${source === 'zip' ? '#8ce5c8' : 'var(--border2)'}">${ico('archive', 19)} <strong>Upload ZIP</strong>${source === 'zip' ? ico('check', 14) : ''}</button><button type="button" class="tile-option" data-action="source" data-source="github" style="border-color:${source === 'github' ? '#8ce5c8' : 'var(--border2)'}">${ico('github', 19)} <strong>GitHub</strong>${source === 'github' ? ico('check', 14) : ''}</button></div></div>${source === 'zip' ? `<label class="dropzone" id="zipzone" for="zipfile">${ico('upload', 25)}<div style="margin-top:8px"><strong>${esc(fn || 'Choose a .zip project archive')}</strong></div><p>${fn ? `${ui.modalData.fileCount || 0} file entries scanned · detected: ${esc(detected)}` : 'ZIP is inspected locally. Nothing is uploaded until you deploy.'}</p><input id="zipfile" name="zipfile" type="file" accept=".zip,application/zip" /></label><p class="hint">Your archive is uploaded to the build pipeline, validated, and extracted in a secure build environment.</p>` : `<div class="form-row">${!state.githubConnected ? `<div class="callout" style="margin-bottom:13px"><div class="row space"><span class="small">GitHub not connected (demo)</span>${btn('Connect demo', 'toggleGithub', 'btn-small')}</div></div>` : `<div class="row" style="margin-bottom:12px;color:var(--mint)">${ico('check', 15)} <span class="small">GitHub demo account connected</span></div>`}<label class="form-label" for="repo">Repository</label><input id="repo" name="repo" placeholder="owner/my-repository" required value="${attr(ui.modalData.repo || '')}"/><p class="hint">Example: my-org/awesome-api · simulated GitHub fetch</p></div><div class="form-grid"><div class="form-row"><label class="form-label" for="branch">Branch</label><input id="branch" name="branch" value="${attr(ui.modalData.branch || 'main')}" required></div><div class="form-row"><label class="form-label">Deploy on push</label><label class="form-check" style="margin-top:14px"><input type="checkbox" name="autoDeploy" ${ui.modalData.autoDeploy === false ? '' : 'checked'} /> Automatically deploy commits</label></div></div>`}<div class="form-grid" style="margin-top:16px"><div class="form-row"><label class="form-label" for="framework">Framework</label><select id="framework" name="framework"><option value="auto" ${!ui.modalData.framework || ui.modalData.framework === 'auto' ? 'selected' : ''}>Auto detect${source === 'zip' && fn ? ` (${esc(detected)})` : ''}</option><option value="Static HTML" ${ui.modalData.framework === 'Static HTML' ? 'selected' : ''}>Static HTML/CSS/JS</option><option value="React/Vite" ${ui.modalData.framework === 'React/Vite' ? 'selected' : ''}>React / Vite</option><option value="Next.js" ${ui.modalData.framework === 'Next.js' ? 'selected' : ''}>Next.js</option><option value="Node.js/Express" ${ui.modalData.framework === 'Node.js/Express' ? 'selected' : ''}>Node.js / Express</option><option value="NestJS" ${ui.modalData.framework === 'NestJS' ? 'selected' : ''}>NestJS</option><option value="Dockerfile" ${ui.modalData.framework === 'Dockerfile' ? 'selected' : ''}>Custom Dockerfile</option></select></div><div class="form-row"><label class="form-label" for="strategy">Build strategy</label><select id="strategy" name="strategy"><option value="automatic">Automatic (recommended)</option><option value="custom">Custom configuration later</option></select></div></div><div class="callout" style="margin-top:3px"><div class="row"><span style="color:var(--mint)">${ico('zap', 18)}</span><span class="callout-title">One unified deployment engine</span></div><p>Validate → Detect → Build → Start → Health Check → Activate HTTPS.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Start deployment ${ico('rocket', 16)}</button></div></form>`;
  }
  if (type === 'database') {
    html =
      `<form id="databaseForm">${projSelect}<div class="form-grid"><div class="form-row"><label class="form-label" for="dbname">Service name</label><input name="name" id="dbname" placeholder="customer-db" pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-]*" required></div><div class="form-row"><label class="form-label" for="engine">Database engine</label><select id="engine" name="engine"><option value="PostgreSQL">PostgreSQL</option><option value="MySQL">MySQL</option><option value="MariaDB">MariaDB</option></select></div></div><div class="form-row"><label class="form-label" for="database">Database name</label><input id="database" name="database" placeholder="my_app_production" pattern="[a-zA-Z][a-zA-Z0-9_]*" required></div><div class="callout"><div class="row">${ico('lock', 17)} <span class="callout-title">Private by default</span></div><p>External connections must be explicitly enabled with source-IP restrictions, encryption, and authentication.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Provision database ${ico('arrow', 15)}</button></div></form>`;
  }
  if (type === 'cron') {
    html =
      `<form id="cronForm">${projSelect}<div class="form-row"><label class="form-label" for="cronname">Job name</label><input id="cronname" name="name" maxlength="64" placeholder="Daily cleanup" required></div><div class="form-grid"><div class="form-row"><label class="form-label" for="method">HTTP method</label><select id="method" name="method"><option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option></select></div><div class="form-row"><label class="form-label" for="schedule">Schedule</label><select id="schedule" name="schedule"><option value="*/5 * * * *">Every 5 minutes</option><option value="0 * * * *">Every hour</option><option value="0 0 * * *">Daily at midnight</option><option value="0 2 * * *">Daily at 02:00</option><option value="0 0 * * 1">Every Monday</option></select></div></div><div class="form-row"><label class="form-label" for="target">HTTPS callback URL</label><input id="target" type="url" name="target" required placeholder="https://api.example.com/tasks/cleanup" pattern="https://.+" title="Must be an HTTPS URL"><p class="hint">In production, requests are authenticated and restricted from private/metadata endpoints.</p></div><div class="form-row"><label class="form-label" for="timezone">Timezone</label><select id="timezone" name="timezone"><option value="Africa/Nairobi">Africa/Nairobi (EAT)</option><option value="UTC">UTC</option><option value="Europe/London">Europe/London</option><option value="America/New_York">America/New_York</option></select></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Create schedule ${ico('clock', 15)}</button></div></form>`;
  }
  if (type === 'domainAttach') {
    const apps = state.services.filter((s) => s.kind === 'application' && s.role !== 'worker');
    const fixed = ui.modalData.serviceId ? apps.find((s) => s.id === ui.modalData.serviceId) : null;
    const hosts = state.hostnames.filter((h) => hostnameAvailable(h) && (!ui.modalData.zoneId || h.zoneId === ui.modalData.zoneId));
    const appChoice = fixed ? `<input type="hidden" name="serviceId" value="${fixed.id}">` :
      `<div class="form-row"><label class="form-label">Application / API</label><select name="serviceId" required>${apps.map((s) => `<option value="${s.id}">${esc(s.name)} · ${esc(project(s.projectId)?.name || 'Project')}</option>`).join('')}</select></div>`;
    html = apps.length && hosts.length ?
      `<form id="domainAttachForm">${appChoice}<div class="form-row"><label class="form-label" for="hostnameId">Available hostname</label><select name="hostnameId" id="hostnameId" required>${hosts.map((h) => `<option value="${h.id}" ${ui.modalData.hostnameId === h.id ? 'selected' : ''}>${esc(h.name)} · ${esc(domainZone(h.zoneId)?.name)}</option>`).join('')}</select><p class="hint">Only verified domains and unassigned hostnames are shown.</p></div><div class="callout"><div class="row">${ico('shield', 17)}<span class="callout-title">One registry, one assignment</span></div><p>This hostname routes to the selected service with automatic HTTPS (Let's Encrypt issued on first request). DNS and subdomain management stay under Domains.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Connect hostname ${ico('arrow', 14)}</button></div></form>` :
      `<div class="empty">${ico('globe', 28)}<h3>${!apps.length ? 'No applications yet' : 'No available verified hostnames'}</h3><p>${!apps.length ? 'Deploy a website or API first.' : 'Register or verify a domain and create an available subdomain in Domains.'}</p>${btn('Go to Domains', 'go', 'btn-primary', 'data-page="domains"')}</div>`;
  }
  if (type === 'domainRegister') html =
    `<form id="domainRegistryForm"><div class="form-row"><label class="form-label" for="regDomain">Domain name</label><input id="regDomain" name="domain" placeholder="example.com" autocomplete="off" required maxlength="253"><p class="hint">Add a domain you own. Configure DNS and nameservers later under Manage → Settings.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Add domain ${ico('arrow', 14)}</button></div></form>`;
  if (type === 'verifyZone') {
    const z = domainZone((ui.modalData.zoneId as string) || (ui.domainZoneId as string));
    const mode = z ? (z.pendingDnsMode || z.dnsMode || 'manual') : 'manual';
    html = z ?
      `<div class="dns-guide">${mode === 'managed' ? `<div class="soft-banner">${ico('globe', 20)}<div><strong>Nameserver delegation (demo)</strong><p>At your domain registrar, replace the existing nameservers only after migrating all records and checking DNSSEC.</p></div></div><div class="dns-guide-grid">${CLOUDLANE_DEMO_NS.map((ns, i) => `<div class="dns-mini-panel"><div class="muted xs">Nameserver ${i + 1}</div><div class="mono small" style="margin:7px 0">${ns}</div>${btn('Copy', 'copy', 'btn-small', `data-copy="${ns}"`)}</div>`).join('')}</div><div class="notice">These .example nameservers are placeholders and WILL NOT resolve. Real managed DNS cannot be activated until two independent authoritative nameservers are deployed.</div>` : `<div class="callout"><h3 class="section-title mono">${esc(z.name)} · Manual DNS</h3><div class="divider"></div><div class="kv"><span class="k">Record type</span><span class="v mono">TXT</span><span class="k">Host</span><span class="v mono">_cloudlane</span><span class="k">Value</span><span class="v mono">cloudlane-verify-demo</span></div><p class="hint">Create the verification TXT at your current DNS host. Demo values are not real verification tokens.</p></div>`}<div class="dns-migration-check"><strong class="small">Before you finish:</strong><label>${ico('check', 15)} Copy existing A/AAAA, CNAME, MX, SPF, DKIM, DMARC and verification records</label><label>${ico('check', 15)} Review DNSSEC / registrar DS records when switching nameservers</label><label>${ico('check', 15)} Confirm your website and email will keep resolving</label></div></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}${btn(mode === 'managed' ? 'Simulate delegation check' : 'Simulate TXT verification', 'verifyZoneConfirm', 'btn-primary', `data-id="${z.id}"`)}</div>` :
      '';
  }
  if (type === 'subdomain') {
    const z = domainZone((ui.modalData.zoneId as string) || (ui.domainZoneId as string));
    html = z ?
      `<form id="subdomainForm"><input type="hidden" name="zoneId" value="${z.id}"><div class="form-row"><label class="form-label" for="subname">Subdomain name</label><div class="subdomain-pair"><input id="subname" name="prefix" required maxlength="63" pattern="[a-zA-Z0-9](?:[a-zA-Z0-9\\-]*[a-zA-Z0-9])?" placeholder="api"><span class="mono muted small">.${esc(z.name)}</span></div><p class="hint">For example, api.${esc(z.name)}. Existing hostnames cannot be reused.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Create subdomain</button></div></form>` :
      '';
  }
  if (type === 'dnsRecord') {
    const z = domainZone((ui.modalData.zoneId as string) || (ui.domainZoneId as string));
    const r = state.dnsRecords.find((x) => x.id === ui.modalData.recordId);
    html = z ?
      `<form id="dnsRecordForm"><input type="hidden" name="zoneId" value="${z.id}"><input type="hidden" name="recordId" value="${r?.id || ''}"><div class="form-grid"><div class="form-row"><label class="form-label">Type</label><select name="type" required>${['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'SRV'].map((t) => `<option ${r?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div><div class="form-row"><label class="form-label">Host / name</label><input name="name" value="${attr(r?.name || '@')}" maxlength="100" required></div></div><div class="form-row"><label class="form-label">Value / target</label><input name="value" value="${attr(r?.value || '')}" required placeholder="203.0.113.42 or mail.example.com" maxlength="512"></div><div class="form-grid"><div class="form-row"><label class="form-label">TTL (seconds)</label><select name="ttl">${[300, 600, 1800, 3600, 7200, 86400].map((n) => `<option value="${n}" ${Number(r?.ttl || 3600) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div><div class="form-row"><label class="form-label">Priority (MX)</label><input name="priority" type="number" min="0" max="65535" value="${r?.priority ?? 10}"></div></div><p class="hint">Records are stored in your workspace database. Manual DNS requires copying them to your current DNS host; managed DNS requires live authoritative infrastructure before publication.</p><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">${r ? 'Save record' : 'Add record'}</button></div></form>` :
      '';
  }
  if (type === 'mailbox') {
    const z = domainZone((ui.modalData.zoneId as string) || (ui.domainZoneId as string));
    const available = state.domainZones.filter((x) => x.status === 'verified');
    html = (z || available.length) ?
      `<form id="mailboxForm">${z ? `<input name="zoneId" type="hidden" value="${z.id}">` : `<div class="form-row"><label class="form-label">Domain</label><select name="zoneId" id="mailDomain" required>${available.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>`}<div class="form-row"><label class="form-label">Email address</label><div class="subdomain-pair"><input name="local" required pattern="[A-Za-z0-9][A-Za-z0-9._+\\-]{0,62}" placeholder="hello"><span class="mono muted small" id="mailSuffix">@${esc(z?.name || available[0]?.name || '')}</span></div></div><div class="form-row"><label class="form-label">Demo storage quota</label><select name="quota"><option value="100">100 MB</option><option value="250">250 MB</option><option value="500">500 MB</option><option value="1000">1 GB</option></select></div><div class="notice">No real mail account or credentials will be created. Real mailbox hosting is optional and subject to server capacity.</div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Create demo mailbox</button></div></form>` :
      '';
  }
  if (type === 'mailAlias') {
    const z = domainZone((ui.modalData.zoneId as string) || (ui.domainZoneId as string));
    const ms = zoneMailboxes(z?.id);
    html = z && ms.length ?
      `<form id="aliasForm"><input name="zoneId" type="hidden" value="${z.id}"><div class="form-row"><label class="form-label">Alias address</label><div class="subdomain-pair"><input name="local" required pattern="[A-Za-z0-9][A-Za-z0-9._+\\-]{0,62}" placeholder="billing"><span class="mono muted small">@${esc(z.name)}</span></div></div><div class="form-row"><label class="form-label">Forward to mailbox</label><select name="target">${ms.map((m) => `<option value="${esc(m.local + '@' + z.name)}">${esc(m.local + '@' + z.name)}</option>`).join('')}</select></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Create alias</button></div></form>` :
      `<div class="empty"><h3>Create a mailbox first</h3><p>Aliases point to an existing account under the same domain.</p>${btn('Create mailbox', 'openModal', 'btn-primary', 'data-modal="mailbox"')}</div>`;
  }
  if (type === 'demoInbox') {
    const m = state.mailboxes.find((x) => x.id === ui.modalData.mailboxId);
    const z = domainZone(m?.zoneId);
    html = m && z ?
      `<div class="soft-banner"><span class="status-icon mint">${ico('mail', 18)}</span><div><strong>${esc(m.local + '@' + z.name)}</strong><p>Local demonstration inbox · no IMAP/SMTP connection</p></div></div><div class="inbox-demo"><div class="inbox-message"><strong>Welcome to your new mailbox</strong><span class="muted xs">Cloudlane demo · just now</span><p>This is a sample message showing how a future inbox may look.</p></div><div class="inbox-message"><strong>Domain configuration checklist</strong><span class="muted xs">System · yesterday</span><p>MX, SPF, DKIM and DMARC will need verification when a real email provider is connected.</p></div></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Close', 'closeModal')}</div>` :
      '';
  }
  if (type === 'variable') {
    const s = service((ui.modalData.serviceId as string) || (ui.serviceId as string));
    html =
      `<form id="variableForm"><p class="muted small">${esc(s?.name || 'Service')}</p><div class="form-row"><label class="form-label" for="varKey">Variable name</label><input id="varKey" name="key" required pattern="[a-zA-Z_][a-zA-Z0-9_]*" placeholder="DATABASE_URL" /></div><div class="form-row"><label class="form-label" for="varValue">Value</label><input id="varValue" name="value" required type="password" placeholder="••••••••••••" autocomplete="new-password" /></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Save variable</button></div></form>`;
  }
  if (type === 'dbAccess') {
    const s = service(ui.modalData.serviceId as string);
    html =
      `<form id="accessForm"><p class="muted small">${esc(s?.name || 'Database')} · Disabled by default</p><div class="form-row"><label class="form-label" for="allowedIp">Allowed client IP (CIDR)</label><input id="allowedIp" name="allowedIp" placeholder="198.51.100.20/32" required value="${attr(s?.allowedIp || '')}" /><p class="hint">Example uses a documentation-only IP. Public wildcard ranges are rejected.</p></div><div class="notice">Public database exposure requires firewall rules, authentication, TLS and preferably a VPN/private tunnel.</div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Enable restricted access</button></div></form>`;
  }
  if (type === 'dns') {
    const d = state.domains.find((x) => x.id === ui.modalData.domainId);
    html =
      `<div class="callout"><div class="row space"><div class="col"><span class="muted xs">Hostname</span><strong class="mono">${esc(d?.name || '—')}</strong></div>${badge('Verification required', 'warn')}</div><div class="divider"></div><div class="kv"><span class="k">Record type</span><span class="v mono">CNAME</span><span class="k">Host</span><span class="v mono">${esc(d?.name || '—')}</span><span class="k">Target</span><span class="v mono">router.apps.example.test</span></div><p class="hint">These are example records only. Actual DNS settings depend on your real VPS and domain.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}${btn('Simulate successful verification', 'confirmDns', 'btn-primary', `data-id="${d?.id || ''}"`)}</div>`;
  }
  if (type === 'dbAdmin') {
    const db = service(ui.modalData.serviceId as string);
    const tool = db?.engine === 'PostgreSQL' ? 'Adminer · PostgreSQL admin' : 'phpMyAdmin';
    html = db ?
      `<div class="soft-banner" style="margin-bottom:16px">${ico('database', 21)}<div><strong>${esc(tool)}</strong><p>Opens in a new tab already signed in as the database application user — no password re-entry. Direct login with credentials is still available on the tool's own page.</p></div></div><div class="card"><div class="row space"><h3 class="section-title">${esc(db.name)} · ${esc(db.engine || '')}</h3>${badge('Auto sign-in', 'ok')}</div><p class="muted small" style="margin-top:8px">The connection goes through the platform's internal network with the application credential from the encrypted secret store. The credential is fetched only when you click Open and is never embedded in the page.</p></div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" data-action="dbAdminGo" data-id="${db.id}">${ico('external', 14)} Open admin tool</button></div>` :
      '';
  }
  if (type === 'dbUserAdd') {
    const db = service(ui.modalData.serviceId as string);
    html = db ?
      `<form id="dbUserAddForm"><input name="serviceId" type="hidden" value="${db.id}"><div class="form-row"><label class="form-label">Username</label><input name="username" required pattern="[A-Za-z][A-Za-z0-9_]{0,47}" placeholder="application_reader" maxlength="48"></div><div class="form-row"><label class="form-label">Privileges</label><select name="preset"><option value="readonly">Read only (recommended)</option><option value="app">Read and write</option><option value="full">Full access</option></select><p class="hint">You can customize individual privileges after creating the user.</p></div><div class="notice">A demo password will be generated. Production access must be scoped, audited and encrypted.</div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Create user</button></div></form>` :
      '';
  }
  if (type === 'dbUserManage') {
    const u = userFor(ui.modalData.userId);
    const db = u && service(u.serviceId);
    html = u && db ?
      `<div class="kv"><span class="k">Username</span><span class="v mono">${esc(u.username)}</span><span class="k">Database</span><span class="v mono">${esc(db.database)}</span><span class="k">Status</span><span class="v">${badge(u.revoked ? 'Revoked' : 'Active', u.revoked ? 'warn' : 'ok')}</span><span class="k">Privileges</span><span class="v">${u.privileges.length} permissions</span><span class="k">Password</span><span class="v mono">${ui.showPassword ? esc(u.password || 'Demo only') : '••••••••••••'} ${btn(ui.showPassword ? 'Hide' : 'Show', 'togglePass', 'btn-small')}</span></div><div class="row" style="margin-top:18px">${btn('Edit privileges', 'openDbPrivileges', 'btn-primary', `data-id="${u.id}"`)}${btn('Rotate password', 'rotateDbUser', '', `data-id="${u.id}"`)}${btn(u.revoked ? 'Restore access' : 'Revoke access', 'toggleDbUser', 'btn-danger', `data-id="${u.id}"`)}</div>` :
      '';
  }
  if (type === 'dbUserPrivileges') {
    const u = userFor(ui.modalData.userId);
    const db = u && service(u.serviceId);
    const privs = db ? dbPrivileges(db) : [];
    html = u && db ?
      `<form id="dbPrivilegesForm"><input name="userId" type="hidden" value="${u.id}"><div class="row space"><div><strong class="mono small">${esc(u.username)}</strong><p class="muted xs">${esc(db.engine)} · ${esc(db.database)}</p></div>${badge(u.revoked ? 'Revoked' : 'Active', u.revoked ? 'warn' : 'ok')}</div><div class="row" style="margin:16px 0">${btn('Full access', 'dbPrivPreset', 'btn-small', 'data-preset="full"')}${btn('Read only', 'dbPrivPreset', 'btn-small', 'data-preset="readonly"')}${btn('Clear', 'dbPrivPreset', 'btn-small', 'data-preset="clear"')}</div><div class="privilege-grid">${privs.map((p) => `<label class="form-check privilege-item"><input type="checkbox" name="privilege" value="${attr(p)}" ${u.privileges.includes(p) ? 'checked' : ''}><span>${esc(p)}</span></label>`).join('')}</div><p class="hint">${db.engine === 'PostgreSQL' ? 'PostgreSQL privileges differ from MySQL grants.' : 'MySQL privileges include table, routine and DDL operations.'} Settings remain a local demonstration.</p><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Save privileges</button></div></form>` :
      '';
  }
  if (type === 'apiKeyCreate') {
    html =
      `<form id="apiKeyForm"><div class="form-row"><label class="form-label">Key name</label><input name="name" required maxlength="50" placeholder="CI deployment automation"></div><div class="form-row"><label class="form-label">Access scope</label><select name="scope"><option value="projects:read">Read projects</option><option value="deployments:write">Create deployments</option><option value="domains:read">Read domains</option></select></div><div class="notice">The generated key is fake and valid nowhere. A real implementation would hash keys at rest and require authentication and expiration policies.</div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button type="submit" class="btn btn-primary">Create demo key</button></div></form>`;
  }
  if (type === 'reset') {
    html =
      `<div class="notice">This will remove all projects, services, simulated deployments and credentials created in this browser and restore the sample workspace.</div><div class="modal-footer" style="margin:20px -24px -24px">${btn('Keep my data', 'closeModal')}${btn('Reset demo workspace', 'resetConfirm', 'btn-danger')}</div>`;
  }
  if (type === 'storageCreate') {
    const projects = state.projects.map((p) =>
      `<option value="${p.id}" ${(ui.modalData.projectId || ui.projectId) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    html =
      `<form id="storageCreateForm"><div class="form-row"><label class="form-label">Project</label><select name="projectId" id="storageProject" required>${projects}<option value="__new__">+ Create new project</option></select></div><div id="storageNewProject" class="form-row" hidden><label class="form-label">New project name</label><input name="newProjectName" placeholder="My mobile app"></div><div class="form-row"><label class="form-label">Storage service name</label><input name="name" required placeholder="maidfinder-media"></div><div class="form-row"><label class="form-label">Storage provider</label><select name="provider"><option value="External S3-compatible">External S3-compatible (recommended)</option><option value="Self-hosted planned" disabled>Self-hosted storage (later, capacity dependent)</option></select></div><div class="notice">Simulated connection only. No real provider credentials are collected. Designed for the 1 GB VPS target.</div><div class="modal-footer">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Create storage</button></div></form>`;
  }
  if (type === 'bucketCreate') {
    const storage = storageService((ui.modalData.serviceId as string) || (ui.serviceId as string));
    html =
      `<form id="bucketCreateForm"><input type="hidden" name="storageId" value="${attr(storage?.id || '')}"><div class="form-row"><label class="form-label">Bucket name</label><input name="name" required placeholder="maidfinder-kyc"></div><div class="form-row"><label class="form-label">What will you store?</label><input name="purpose" maxlength="90" placeholder="Private identity documents"></div><div class="form-row"><label class="form-label">Storage quota (demo)</label><select name="maxMB"><option value="100">100 MB</option><option value="250">250 MB</option><option value="500" selected>500 MB</option><option value="1000">1 GB</option></select></div><div class="notice">All buckets are private by default. Public KYC access is never enabled here.</div><div class="modal-footer">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Create private bucket</button></div></form>`;
  }
  if (type === 'storageFolder') {
    const b = bucket(ui.modalData.bucketId);
    html =
      `<form id="storageFolderForm"><input type="hidden" name="bucketId" value="${attr(ui.modalData.bucketId as string)}"><input type="hidden" name="prefix" value="${attr(String(ui.storagePrefix || ''))}"><div class="form-row"><label class="form-label">Virtual folder name</label><input name="name" placeholder="sample-user-002" required></div><p class="hint">Folders are object-key prefixes inside ${esc(b?.name || 'this bucket')}; they are not VPS directories.</p><div class="modal-footer">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Create prefix</button></div></form>`;
  }
  if (type === 'objectUpload') {
    const b = bucket(ui.modalData.bucketId);
    html =
      `<form id="objectUploadForm"><input type="hidden" name="bucketId" value="${attr(ui.modalData.bucketId as string)}"><div class="form-row"><label class="form-label">Current bucket</label><div class="tiny-code">${esc(b?.name || 'No bucket selected')} / ${esc(String(ui.storagePrefix || ''))}</div></div><div class="form-row"><label class="form-label">Choose local file</label><input type="file" name="file" required accept="image/jpeg,image/png,image/webp,application/pdf"></div><div class="notice">For privacy, this demo only saves filename, size, and file type. The selected file bytes are never uploaded or saved.</div><div class="modal-footer">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Record demo upload</button></div></form>`;
  }
  if (type === 'storageGrant') {
    const storage = storageService((ui.modalData.serviceId as string) || (ui.serviceId as string));
    const apps = state.services.filter((a) => a.projectId === storage?.projectId && a.kind === 'application');
    html =
      `<form id="storageGrantForm"><input type="hidden" name="storageId" value="${attr(storage?.id || '')}"><div class="form-row"><label class="form-label">Application</label><select name="serviceId">${apps.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select></div><div class="form-row"><label class="form-label">Bucket</label><select name="bucketId">${bucketsFor(storage?.id).map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div><div class="form-row"><label class="form-label">Permission scope</label><select name="scope"><option value="read">Read objects</option><option value="upload">Upload only</option><option value="read-write">Read and write</option></select></div><div class="notice">Visual permissions only. A production connection must generate revocable, scoped credentials and issue short-lived signed URLs as needed.</div><div class="modal-footer">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Grant access (demo)</button></div></form>`;
  }
  if (type === 'volumeCreate') {
    html =
      `<form id="volumeCreateForm"><input type="hidden" name="serviceId" value="${attr(ui.serviceId as string)}"><div class="form-row"><label class="form-label">Volume name</label><input name="name" required placeholder="application-uploads"></div><div class="form-row"><label class="form-label">Container mount location</label><select name="mount"><option value="/data">/data</option><option value="/uploads">/uploads</option><option value="/cache">/cache</option></select></div><div class="form-row"><label class="form-label">Quota</label><select name="quotaMB"><option value="100">100 MB</option><option value="250">250 MB</option><option value="500">500 MB</option></select></div><div class="notice">Allocated container volumes only. No arbitrary host paths, bind mounts or operating system browsing.</div><div class="modal-footer">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Allocate demo volume</button></div></form>`;
  }
  if (type === 'storageInspect') {
    const obj = state.objects.find((o) => o.id === ui.modalData.objectId);
    const ob = obj && bucket(obj.bucketId);
    html = obj ?
      `<div class="kv"><span class="k">Object key</span><span class="v mono">${esc(obj.key)}</span><span class="k">Bucket</span><span class="v mono">${esc(ob?.name || '')}</span><span class="k">Content type</span><span class="v">${esc(obj.type)}</span><span class="k">Size</span><span class="v">${bytesHuman(obj.size)}</span><span class="k">Availability</span><span class="v">Demo metadata only</span><span class="k">Privacy</span><span class="v">Private (no public URL)</span></div><div class="notice" style="margin-top:16px">KYC bytes are not included in this prototype. Access to identity documents requires explicit authorization, audit events, and time-limited links in production.</div><div class="modal-footer">${btn('Close', 'closeModal')}</div>` :
      '';
  }
  if (type === 'dnsModeChange') {
    const z = domainZone(ui.modalData.zoneId as string);
    if (!z) html = '';
    else {
      const target = z.dnsMode === 'managed' ? 'manual' : 'managed';
      html = `<form id="dnsModeChangeForm"><input type="hidden" name="zoneId" value="${attr(z.id)}"><input type="hidden" name="target" value="${target}"><div class="notice">Switching authoritative DNS can interrupt websites and email. Cloudlane will not change registrar settings for you.</div><div class="dns-guide"><div class="dns-step"><span class="dns-step-index">1</span><span class="small">Copy your current A/AAAA, CNAME, MX, SPF, DKIM, DMARC and other DNS records.</span></div><div class="dns-step"><span class="dns-step-index">2</span><span class="small">Review DNSSEC / DS records at your registrar and plan a safe transition.</span></div><div class="dns-step"><span class="dns-step-index">3</span><span class="small">${target === 'managed' ? 'Prepare reliable authoritative nameservers and change registrar delegation only when ready.' : 'Recreate the zone at your external DNS provider, then change delegation back there.'}</span></div></div><label class="small" style="display:flex;align-items:flex-start;gap:10px;margin:12px 0"><input type="checkbox" name="understand" required style="width:auto;margin-top:3px">I understand this is only a preview and no live DNS is changed.</label><div class="modal-footer" style="margin:20px -24px -24px">${btn('Cancel', 'closeModal')}<button class="btn btn-primary" type="submit">Prepare ${target === 'managed' ? 'managed' : 'manual'} DNS</button></div></form>`;
    }
  }
  return `<div class="modal-wrap" data-action="overlayClose"><div class="modal ${['deploy', 'dbUserPrivileges'].includes(type) ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(info[0])}" id="modal"><div class="modal-head"><div><h2>${esc(info[0])}</h2><p>${esc(info[1])}</p></div><button class="icon-btn" data-action="closeModal" aria-label="Close dialog">${ico('close', 18)}</button></div><div class="modal-body">${html}</div></div></div>`;
}
/* ── actions — prototype mutation surface, rewired to the real API ── */

const STAGES: [string, string, string][] = [
  ['QUEUED', 'Accept deployment', 'Preparing deployment job'],
  ['FETCHING', 'Retrieve source', 'Reading ZIP or repository revision'],
  ['VALIDATING', 'Validate files', 'Checking structure and inputs'],
  ['DETECTING', 'Detect framework', 'Selecting a build strategy'],
  ['BUILDING', 'Build application', 'Creating a runnable artifact'],
  ['STARTING', 'Start candidate', 'Starting isolated container'],
  ['HEALTH_CHECKING', 'Health check', 'Checking service readiness'],
  ['ACTIVATING', 'Activate release', 'Switching production routing'],
  ['LIVE', 'Live', 'Release is serving traffic']
];
const activeTimers = new Map<string, ReturnType<typeof setInterval>>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function addLog(d: DeploymentRec, msg: string, level = 'info'): void {
  d.logs.push({ msg, level });
  d.logs = d.logs.slice(-50);
}

function findDeployment(id: string) {
  return state.deployments.find((v) => v.id === id);
}

/** Client-side stage animation for simulated deployments; server persists the final state. */
function runDeployment(id: string): void {
  if (activeTimers.has(id)) return;
  const t = setInterval(() => {
    const d = findDeployment(id);
    if (!d || ['LIVE', 'FAILED', 'CANCELLED'].includes(d.status)) {
      clearInterval(t);
      activeTimers.delete(id);
      return;
    }
    const s = service(d.serviceId);
    if (!s) { clearInterval(t); activeTimers.delete(id); return; }
    d.stage = Math.min(8, Number(d.stage || 0) + 1);
    d.status = STAGES[d.stage][0];
    const messages: Record<string, string> = {
      FETCHING: `[SOURCE] ${s.source === 'github' ? 'Checked out ' + s.repo + ' @ ' + s.branch : 'Read ' + s.fileName}`,
      VALIDATING: '[VALIDATE] Source accepted · size and paths checked',
      DETECTING: `[DETECT] ${s.framework} · ${cap(s.role)} service`,
      BUILDING: `[BUILD] Compiling ${s.framework} artifact`,
      STARTING: '[RUNTIME] Candidate container started',
      HEALTH_CHECKING: '[HEALTH] Waiting for healthy response',
      ACTIVATING: '[ROUTE] Preparing atomic route switch',
      LIVE: '[READY] Deployment healthy and live'
    };
    addLog(d, messages[d.status] || `[STEP] ${d.status}`, d.status === 'LIVE' ? 'success' : 'info');
    if (d.failAt === d.status) {
      d.status = 'FAILED';
      d.finished = NOW();
      addLog(d, `[ERROR] Simulated ${cap(d.failAt)} failure. Candidate not activated.`, 'error');
      void apply('finalizeDeployment', { deploymentId: d.id, failed: true, logs: d.logs });
      if (!s.activeDeployment) s.status = 'failed';
      activity('Deployment failed', `${s.name} · existing healthy release retained`, 'deploy');
      flash('Deployment failed safely. Previous working release retained.', true);
      clearInterval(t);
      activeTimers.delete(id);
    } else if (d.status === 'LIVE') {
      d.finished = NOW();
      s.activeDeployment = d.id;
      s.status = 'running';
      void apply('finalizeDeployment', { deploymentId: d.id, failed: false, logs: d.logs });
      activity('Deployment is live', `${s.name} · release ${d.revision}`, 'deploy');
      flash(`${s.name} is live.`);
      clearInterval(t);
      activeTimers.delete(id);
    }
    if (ui.page === 'service' && ui.serviceId === d.serviceId && ['overview', 'deployments', 'logs'].includes(ui.tab as string)) render();
    else if (ui.page === 'overview') render();
  }, 650);
  activeTimers.set(id, t);
}

/** Start a simulated deployment row (QUEUED) through the actions API, then animate. */
async function startDeployment(serviceId: string, failAt: string | null = null): Promise<void> {
  const s = service(serviceId);
  if (!s) return;
  const ds = deploymentsFor(serviceId);
  if (ds.some((d) => !['LIVE', 'FAILED', 'CANCELLED'].includes(d.status))) {
    flash('A deployment is already running for this service.', true);
    return;
  }
  const ok = await apply('simulateDeployment', { serviceId, failAt });
  if (!ok) return;
  // apply() refreshed state — locate the newest queued deployment for this service
  const d = deploymentsFor(serviceId).find((x) => x.status === 'QUEUED');
  if (!d) return;
  d.failAt = failAt;
  d.simulating = true;
  addLog(d, `[QUEUE] Accepted deployment for ${s.name}`);
  runDeployment(d.id);
}

async function copyText(str: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    navigator.clipboard.writeText(str).then(() => flash('Copied to clipboard.')).catch(() => flash('Copy not available in this browser.', true));
  } else {
    const input = document.createElement('textarea');
    input.value = str;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      flash('Copied to clipboard.');
    } catch {
      flash('Copy not available; select and copy manually.', true);
    }
    input.remove();
  }
}

async function inspectZip(file: File): Promise<{ framework: string; count: number }> {
  const MAX = 100 * 1024 * 1024;
  if (!file.name.toLowerCase().endsWith('.zip')) throw Error('Choose a .zip archive.');
  if (file.size > MAX) throw Error('The demo accepts ZIP files up to 100 MB.');
  const buf = await file.arrayBuffer();
  const v = new DataView(buf);
  if (v.byteLength < 22) throw Error('Invalid or empty ZIP file.');
  let eocd = -1;
  for (let i = v.byteLength - 22; i >= Math.max(0, v.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('Could not read ZIP directory. Ensure this is a valid ZIP file.');
  const count = v.getUint16(eocd + 10, true);
  let offset = v.getUint32(eocd + 16, true);
  const names: string[] = [];
  if (count > 10000) throw Error('Too many archive entries for the demo.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > v.byteLength || v.getUint32(offset, true) !== 0x02014b50) throw Error('ZIP central directory is damaged.');
    const nl = v.getUint16(offset + 28, true);
    const el = v.getUint16(offset + 30, true);
    const cl = v.getUint16(offset + 32, true);
    if (offset + 46 + nl > v.byteLength) throw Error('ZIP filename is damaged.');
    names.push(new TextDecoder().decode(new Uint8Array(buf, offset + 46, nl)).replaceAll('\\', '/').toLowerCase());
    offset += 46 + nl + el + cl;
  }
  const has = (needle: string) => names.some((n) => n.endsWith(needle));
  const framework = has('nest-cli.json') ? 'NestJS' : has('next.config.js') || has('next.config.mjs') || has('next.config.ts') ? 'Next.js'
    : has('vite.config.js') || has('vite.config.ts') ? 'React/Vite' : has('dockerfile') ? 'Dockerfile'
    : has('index.html') && !has('package.json') ? 'Static HTML' : has('package.json') ? 'Node.js/Express'
    : has('index.html') ? 'Static HTML' : 'Node.js/Express';
  return { framework, count: names.length };
}

function snapshotDeployForm(): void {
  if (ui.modal !== 'deploy') return;
  const f = document.getElementById('deployForm') as HTMLFormElement | null;
  if (!f) return;
  for (const key of ['projectId', 'newProjectName', 'name', 'repo', 'branch', 'framework', 'strategy']) {
    const control = f.elements.namedItem(key) as HTMLInputElement | null;
    if (control && typeof control.value === 'string') ui.modalData[key] = control.value;
  }
  const cb = f.elements.namedItem('autoDeploy') as HTMLInputElement | null;
  if (cb) ui.modalData.autoDeploy = cb.checked;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const formData = (form: HTMLFormElement) =>
  Object.fromEntries(new FormData(form).entries()) as Record<string, string | boolean>;

/** ZIP deploy — the real pipeline: uploads → service → deployment. */
async function deployFromZip(data: Record<string, string | boolean>): Promise<void> {
  const file = ui.modalData.fileObj as File | undefined;
  if (!file) { flash('Choose a ZIP file before deploying.', true); return; }
  const name = String(data.name || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) { flash('Use a valid application service name.', true); return; }
  try {
    const detected = (ui.modalData.detected as string) || 'Node.js/Express';
    const framework = data.framework === 'auto' ? detected : String(data.framework);
    const role = framework === 'NestJS' || (framework === 'Node.js/Express' && /api|backend|server/i.test(name)) ? 'api' : 'web';
    const projectId = data.projectId !== '__new__' ? String(data.projectId)
      : await (async () => {
        const newName = String(data.newProjectName || '').trim();
        if (newName.length < 2 || newName.length > 62) { flash('Enter a project name (2–62 characters).', true); return null; }
        // Project creation goes through the workspace actions API, then we look it up.
        const ok = await apply('createProject', { name: newName });
        if (!ok) return null;
        return state.projects.find((p) => p.slug === newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''))?.id ?? null;
      })();
    if (!projectId) return;
    const init = await api.post<{ uploadId: string }>('/uploads/init', {
      filename: file.name, size: file.size, mimeType: 'application/zip',
    });
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/zip' }), file.name);
    await api.putForm(`/uploads/${init.uploadId}/receive?sha256=${encodeURIComponent(hash)}`, form);
    await api.post(`/uploads/${init.uploadId}/finalize`, { sha256: hash });
    const created = await api.post<{ serviceId: string; deploymentId: string }>(`/projects/${projectId}/services`, {
      name, role, source: 'zip', uploadId: init.uploadId, framework,
    });
    activity('Deployment requested', `${name} · ZIP`, 'deploy');
    ui.modal = null;
    await syncState();
    go('service', null, created.serviceId, 'deployments');
    flash('Deployment started. Watch its progress in Deployments.');
  } catch (err) {
    flash(err instanceof ApiError ? err.message : 'The upload or deployment failed. Please try again.', true);
  }
}

function previewCommand(s: ServiceRec, cmd: string): { kind: string; text: string } {
  const c = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  const versions = 'v22.x (illustrative)';
  if (c === 'help') return { kind: 'system', text: 'Available demo commands: ' + safePreviewCommands.join(', ') };
  if (c === 'pwd') return { kind: 'ok', text: '/app' };
  if (c === 'ls' || c === 'ls -la') return { kind: 'ok', text: 'dist  node_modules  package.json  public' };
  if (c === 'whoami') return { kind: 'ok', text: 'app (unprivileged container identity)' };
  if (c === 'node --version' || c === 'node -v') return { kind: 'ok', text: versions };
  if (c === 'npm --version') return { kind: 'ok', text: '10.x (illustrative)' };
  if (c === 'ps') return { kind: 'ok', text: 'PID  COMMAND\n  1  node dist/main.js' };
  if (c === 'date') return { kind: 'ok', text: new Date().toUTCString() + ' (browser clock)' };
  if (c === 'git status') return { kind: 'ok', text: 'Deployment artifact is immutable; not a writable Git checkout.' };
  if (c === 'cat package.json') return { kind: 'ok', text: JSON.stringify({ name: s.name, private: true, scripts: { start: 'node dist/main.js' } }, null, 2) + '\n[synthetic example]' };
  if (c === 'env') return { kind: 'blocked', text: 'Secrets protected. Environment variables are never printed by this demo.' };
  return { kind: 'blocked', text: 'Blocked in preview. Only allowlisted read-only demo commands are supported. No command was executed.' };
}

function runDemoCommand(cmd: string): void {
  const s = service(ui.serviceId);
  const session = s ? terminalSession(s) : null;
  if (!session || !terminalAllowed(s)) { flash('Session expired or permission denied.', true); return; }
  const value = cmd.trim();
  if (!value) return;
  if (value.toLowerCase() === 'clear') { (session as { entries: unknown[] }).entries = []; render(); return; }
  if (value.toLowerCase() === 'exit') { endTerminalSession('Exited terminal.'); render(); return; }
  const sess = ui.termSession as { entries: { kind: string; text: string }[] };
  sess.entries.push({ kind: 'prompt', text: 'app@' + (s?.name ?? '') + ':/app$ ' + value });
  const result = previewCommand(s as ServiceRec, value);
  sess.entries.push(result);
  if (result.kind === 'blocked') {
    activity('Terminal command blocked', `${s?.name} · policy enforced`, 'system');
  }
  sess.entries = sess.entries.slice(-45);
  render();
  const inp = document.getElementById('terminalCommand') as HTMLInputElement | null;
  if (inp) inp.focus();
}

function runDemoSql(query: string): void {
  const s = service(ui.serviceId);
  if (!s || s.kind !== 'database') return;
  const q = query.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ').toLowerCase();
  const pg = s.engine === 'PostgreSQL';
  const result = { serviceId: s.id, blocked: false, columns: [] as string[], rows: [] as unknown[][], message: 'Synthetic preview rows; no SQL was executed.' };
  if (q === (pg ? 'select current_database()' : 'select database()')) {
    result.columns = [pg ? 'current_database' : 'DATABASE()'];
    result.rows = [[s.database]];
  } else if (!pg && q === 'show tables') {
    result.columns = ['Tables_in_' + s.database];
    result.rows = [['users'], ['bookings'], ['profiles']];
  } else if (pg && q === 'select table_name from information_schema.tables limit 5') {
    result.columns = ['table_name'];
    result.rows = [['users'], ['bookings'], ['profiles']];
  } else if (q === 'select * from users limit 5') {
    result.columns = ['id', 'email', 'status'];
    result.rows = [[1, 'alex@example.test', 'active'], [2, 'taylor@example.test', 'active'], [3, 'sam@example.test', 'pending']];
  } else {
    result.blocked = true;
    result.message = /^(insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|call|exec|begin|commit|set)\b/.test(q)
      ? 'Write or administrative statements are not permitted in this read-only prototype.'
      : 'Only the listed, exact preview queries are supported. Nothing was executed.';
  }
  ui.sqlDraft = query;
  ui.sqlResult = result;
  activity(result.blocked ? 'Demo SQL preview rejected' : 'Demo SQL preview viewed', `${s.name} · ${s.engine}`, 'database');
  render();
}

const fiveMinutes = 5 * 60 * 1000;

function doAction(action: string, el: HTMLElement, event: Event): void {
  const id = (el.dataset.id || '') as string;
  switch (action) {
    case 'go': {
      if (ui.termSession) endTerminalSession('Left application detail.');
      if (el.dataset.page === 'settings') ui.settingsTab = 'workspace';
      go(String(el.dataset.page));
      break;
    }
    case 'openProject':
      ui.projectTab = 'services';
      if (ui.termSession) endTerminalSession('Navigated away from previous container.');
      go('project', id);
      break;
    case 'openService': {
      if (ui.termSession) endTerminalSession('Navigated away from previous container.');
      const target = service(id);
      if (target?.kind === 'storage') {
        ui.storageBucketId = bucketsFor(id)[0]?.id || null;
        ui.storagePrefix = '';
        ui.storageSearch = '';
      }
      ui.showPassword = false;
      go('service', null, id);
      break;
    }
    case 'serviceTab':
      ui.tab = el.dataset.tab;
      ui.showPassword = false;
      render();
      window.history.replaceState({}, '', buildPath(ui.page as string, ui.projectId as string | null, ui.serviceId as string | null, String(ui.tab)));
      break;
    case 'new':
      openModal('new', { projectId: el.dataset.project || ui.projectId || state.projects[0]?.id });
      break;
    case 'newType':
      if (el.dataset.type === 'storageCreate') {
        openModal('storageCreate', { projectId: ui.modalData.projectId || ui.projectId || state.projects[0]?.id });
        return;
      }
      openModal(String(el.dataset.type), { projectId: ui.modalData.projectId || ui.projectId || state.projects[0]?.id });
      break;
    case 'openModal':
      if (['bucketCreate', 'objectUpload', 'storageFolder', 'storageGrant', 'storageCreate', 'volumeCreate'].includes(String(el.dataset.modal))) {
        openModal(String(el.dataset.modal), {
          projectId: el.dataset.project || ui.projectId,
          serviceId: el.dataset.service || ui.serviceId,
          bucketId: el.dataset.bucketId || ui.storageBucketId,
        });
        return;
      }
      openModal(String(el.dataset.modal), {
        projectId: el.dataset.project || ui.projectId || state.projects[0]?.id,
        serviceId: el.dataset.service || ui.serviceId || '',
      });
      break;
    case 'closeModal':
      ui.modal = null;
      ui.modalData = {};
      render();
      break;
    case 'overlayClose':
      if (el === event.target) { ui.modal = null; ui.modalData = {}; render(); }
      break;
    case 'mobileMenu':
      ui.mobileMenu = !ui.mobileMenu;
      render();
      break;
    case 'dismissToast':
      ui.toast = null;
      renderToast();
      break;
    case 'workspace':
      go('settings');
      break;
    case 'source':
      snapshotDeployForm();
      ui.modalData.source = el.dataset.source;
      ui.modalData.fileObj = null;
      ui.modalData.fileName = null;
      render();
      break;
    case 'toggleGithub':
      void apply('toggleGithub').then((ok) => {
        if (ok) flash(state.githubConnected ? 'Demo GitHub account connected.' : 'Demo GitHub account disconnected.');
      });
      break;
    case 'copy':
      void copyText(el.dataset.copy || '');
      break;
    case 'openExternal':
      window.open(el.dataset.url || '', '_blank', 'noopener');
      break;
    case 'dbAdminGo': {
      const svcId = String(el.dataset.id || '');
      ui.modal = null;
      render();
      api.get<{ tool: string; action: string; fields: Record<string, string> }>(`/services/${svcId}/db-admin`)
        .then((link) => {
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = link.action;
          form.target = '_blank';
          for (const [k, v] of Object.entries(link.fields)) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = k;
            input.value = v;
            form.appendChild(input);
          }
          document.body.appendChild(form);
          form.submit();
          form.remove();
          flash(`Connected to ${link.tool}.`);
        })
        .catch((err: unknown) => {
          flash(err instanceof ApiError ? err.message : 'Could not open the database admin tool.', true);
        });
      break;
    }
    case 'redeploy': {
      const s = service(id);
      if (!s) break;
      // Real ZIP services go through the real pipeline; demo sources simulate.
      if (s.source === 'zip' && s.kind === 'application') {
        void api.post(`/services/${id}/deployments/redeploy`, {}).then(async () => {
          await syncState();
          go('service', null, id, 'deployments');
          flash('Redeployment started.');
        }).catch(() => { void startDeployment(id); go('service', null, id, 'deployments'); });
      } else {
        void startDeployment(id);
        go('service', null, id, 'deployments');
      }
      break;
    }
    case 'simulatePush': {
      const s = service(id);
      if (!s) return;
      if (!s.autoDeploy) { flash('Auto deploy is disabled.', true); return; }
      void startDeployment(id);
      go('service', null, id, 'deployments');
      flash('Simulated GitHub webhook received.');
      break;
    }
    case 'failBuild':
      void startDeployment(id, 'BUILDING');
      go('service', null, id, 'deployments');
      break;
    case 'failHealth':
      void startDeployment(id, 'HEALTH_CHECKING');
      go('service', null, id, 'deployments');
      break;
    case 'openLogs':
      ui.tab = 'logs';
      ui.modalData.logDeployment = id;
      render();
      break;
    case 'rollback': {
      void apply('rollbackDeployment', { deploymentId: id }).then((ok) => {
        if (ok) { flash('Previous healthy release restored.'); render(); }
      });
      break;
    }
    case 'verifyDomain':
      ui.modal = 'dns';
      ui.modalData = { domainId: id };
      render();
      break;
    case 'confirmDns': {
      void apply('confirmPlatformDns', { domainId: id }).then((ok) => {
        ui.modal = null;
        if (ok) { flash('Domain verification and HTTPS simulated successfully.'); render(); }
      });
      break;
    }
    case 'togglePass':
      ui.showPassword = !ui.showPassword;
      render();
      break;
    case 'removeVar': {
      const s = service(id);
      const i = Number(el.dataset.index);
      if (s && i >= 0) {
        void apply('removeVar', { serviceId: id, index: i }).then((ok) => {
          if (ok) { flash('Environment variable removed.'); render(); }
        });
      }
      break;
    }
    case 'dbAccess': {
      const s = service(id);
      if (!s) return;
      if (s.external) {
        void apply('dbAccessDisable', { serviceId: id }).then((ok) => {
          if (ok) { flash('External access disabled.'); render(); }
        });
      } else {
        openModal('dbAccess', { serviceId: id });
      }
      break;
    }
    case 'rotateDb': {
      void apply('rotateDb', { serviceId: id }).then((ok) => {
        if (ok) { ui.showPassword = false; flash('Password rotated.'); render(); }
      });
      break;
    }
    case 'backupDb': {
      void apply('backupDb', { serviceId: id }).then((ok) => {
        if (ok) { flash('Backup recorded.'); render(); }
      });
      break;
    }
    case 'toggleCron': {
      void apply('toggleCron', { serviceId: id }).then((ok) => {
        if (ok) { flash('Job updated.'); render(); }
      });
      break;
    }
    case 'runCron': {
      const s = service(id);
      if (!s) return;
      void apply('runCron', { serviceId: id }).then((ok) => {
        if (ok) {
          activity('Cron execution started', s.name, 'cron');
          const failing = (s.target || '').includes('/fail');
          flash(failing ? 'Simulated HTTP request failed.' : 'Simulated HTTP request completed.', failing);
          render();
        }
      });
      break;
    }
    case 'resetPrompt':
      openModal('reset');
      break;
    case 'resetConfirm': {
      for (const t of activeTimers.values()) clearInterval(t);
      activeTimers.clear();
      ui.modal = null;
      ui.modalData = {};
      void apply('reset').then((ok) => {
        if (ok) { go('overview'); flash('Sample workspace restored.'); }
      });
      break;
    }
    case 'openDomain':
      go('domainDetail', id);
      break;
    case 'domainTab':
      ui.tab = el.dataset.tab;
      render();
      window.history.replaceState({}, '', buildPath('domainDetail', ui.domainZoneId as string | null, null, String(ui.tab)));
      break;
    case 'connectHost':
      openModal('domainAttach', { zoneId: state.hostnames.find((h) => h.id === id)?.zoneId, hostnameId: id });
      break;
    case 'verifyZoneConfirm': {
      void apply('verifyZone', { zoneId: id }).then((ok) => {
        ui.modal = null;
        if (ok) { flash('DNS verification simulated. No public DNS was changed.'); go('domainDetail', id, null, 'overview'); }
      });
      break;
    }
    case 'editDns': {
      const r = state.dnsRecords.find((x) => x.id === id);
      if (r) openModal('dnsRecord', { zoneId: r.zoneId, recordId: r.id });
      break;
    }
    case 'deleteDns': {
      if (!confirm('Remove this DNS record?')) return;
      void apply('deleteDns', { recordId: id }).then((ok) => {
        if (ok) { render(); flash('DNS record removed.'); }
      });
      break;
    }
    case 'deleteHostname': {
      const h = state.hostnames.find((x) => x.id === id);
      if (!h) return;
      if (h.type === 'apex' || h.serviceId) { flash('Disconnect this hostname first.', true); return; }
      if (!confirm('Delete subdomain ' + h.name + '?')) return;
      void apply('deleteHostname', { hostnameId: id }).then((ok) => {
        if (ok) { render(); flash('Subdomain deleted.'); }
      });
      break;
    }
    case 'unassignHostname': {
      const h = state.hostnames.find((x) => x.id === id);
      if (!h || !h.serviceId) return;
      const s = service(h.serviceId);
      if (!confirm('Disconnect ' + h.name + ' from ' + (s?.name || 'this service') + '?')) return;
      void apply('unassignHostname', { hostnameId: id }).then((ok) => {
        if (ok) { render(); flash('Hostname is now available in the registry.'); }
      });
      break;
    }
    case 'recheckSsl': {
      void apply('recheckSsl', { zoneId: id }).then((ok) => {
        if (ok) { render(); flash('HTTPS verification simulated.'); }
      });
      break;
    }
    case 'openInbox':
      openModal('demoInbox', { mailboxId: id, zoneId: state.mailboxes.find((m) => m.id === id)?.zoneId });
      break;
    case 'deleteMailbox': {
      const m = state.mailboxes.find((x) => x.id === id);
      if (!m) return;
      const z = domainZone(m.zoneId);
      if (!confirm(`Delete demo mailbox ${m.local}@${z?.name} and any aliases pointing to it?`)) return;
      void apply('deleteMailbox', { mailboxId: id }).then((ok) => {
        if (ok) { render(); flash('Mailbox removed.'); }
      });
      break;
    }
    case 'deleteAlias': {
      if (!confirm('Remove this alias?')) return;
      void apply('deleteAlias', { aliasId: id }).then((ok) => {
        if (ok) { render(); flash('Alias removed.'); }
      });
      break;
    }
    case 'deleteZone': {
      const z = domainZone(id);
      if (!z) return;
      if (zoneHostnames(id).some((h) => h.serviceId)) { flash('Disconnect all project hostnames before removing this domain.', true); return; }
      if (!confirm(`Remove domain ${z.name} and all its simulated DNS records and email accounts?`)) return;
      void apply('deleteZone', { zoneId: id }).then((ok) => {
        if (ok) { flash('Domain removed from the registry.'); go('domains'); }
      });
      break;
    }
    case 'openDomainEmail':
      go('domainDetail', id, null, 'email');
      break;
    case 'openDbUser':
      ui.showPassword = false;
      openModal('dbUserManage', { serviceId: userFor(id)?.serviceId, userId: id });
      break;
    case 'openDbPrivileges':
      ui.showPassword = false;
      openModal('dbUserPrivileges', { serviceId: userFor(id)?.serviceId, userId: id });
      break;
    case 'dbPrivPreset': {
      const f = document.getElementById('dbPrivilegesForm') as HTMLFormElement | null;
      if (!f) return;
      const u = userFor((f.elements.namedItem('userId') as HTMLInputElement)?.value);
      const db = u && service(u.serviceId);
      if (!u || !db) return;
      const selected = el.dataset.preset === 'full' ? dbPrivileges(db)
        : el.dataset.preset === 'readonly' ? (db.engine === 'PostgreSQL' ? ['CONNECT', 'USAGE', 'SELECT'] : ['SELECT', 'SHOW VIEW'])
        : [];
      f.querySelectorAll('input[name="privilege"]').forEach((inp) => { (inp as HTMLInputElement).checked = selected.includes((inp as HTMLInputElement).value); });
      break;
    }
    case 'toggleDbUser': {
      const u = userFor(id);
      if (!u) return;
      if (!u.revoked && !confirm(`Revoke access for ${u.username} to this database?`)) return;
      void apply('toggleDbUser', { userId: id }).then((ok) => {
        ui.modal = null;
        if (ok) { render(); flash(u.revoked ? 'User access restored.' : 'User access revoked.'); }
      });
      break;
    }
    case 'rotateDbUser': {
      void apply('rotateDbUser', { userId: id }).then((ok) => {
        if (ok) { ui.showPassword = true; render(); flash('User password rotated.'); }
      });
      break;
    }
    case 'projectTab':
      if (el.dataset.tab === 'storage') { ui.projectTab = 'storage'; render(); return; }
      ui.projectTab = el.dataset.tab;
      render();
      break;
    case 'settingsTab':
      ui.settingsTab = el.dataset.tab;
      if (el.dataset.fromDocs || el.dataset.fromStorage) ui.page = 'settings';
      render();
      break;
    case 'openDocs':
      go('docs');
      break;
    case 'assistantOpen':
      ui.assistantOpen = true;
      if (el.dataset.prompt) ui.assistantText = el.dataset.prompt;
      render();
      return;
    case 'assistantClose':
      ui.assistantOpen = false;
      render();
      return;
    case 'assistantPrompt': {
      ui.assistantText = String(el.dataset.prompt || '');
      const q = document.getElementById('assistantQuery') as HTMLTextAreaElement | null;
      if (q) { q.value = ui.assistantText; q.focus(); }
      return;
    }
    case 'assistantApprove': {
      const p = ui.assistantPlan as { approved?: boolean; progress?: number; steps?: string[]; complete?: boolean; summary?: string } | null;
      if (!p || p.approved) return;
      p.approved = true;
      p.progress = -1;
      render();
      let n = 0;
      const timer = setInterval(() => {
        if (ui.assistantPlan !== p) { clearInterval(timer); return; }
        p.progress = n++;
        if (n >= (p.steps?.length ?? 0)) {
          clearInterval(timer);
          p.complete = true;
          void apply('assistantApproved', { summary: p.summary });
          flash('Plan simulated; no infrastructure changed.');
        }
        render();
      }, 380);
      return;
    }
    case 'assistantDiscard':
      ui.assistantPlan = null;
      render();
      return;
    case 'addServiceLink': {
      void apply('simulatePushServiceLink', { from: el.dataset.from, to: el.dataset.to }).then((ok) => {
        if (ok) { render(); flash('Visual connection created (demo).'); }
      });
      return;
    }
    case 'removeServiceLink': {
      void apply('removeServiceLink', { id }).then((ok) => {
        if (ok) { render(); flash('Demo connection removed.'); }
      });
      return;
    }
    case 'openApiKey':
      openModal('apiKeyCreate');
      return;
    case 'revokeApiKey': {
      const k = state.apiKeys.find((x) => x.id === id);
      if (!k || k.revoked) return;
      if (!confirm('Revoke this nonfunctional demo key?')) return;
      void apply('apiKeyRevoke', { id }).then((ok) => {
        if (ok) { render(); flash('Demo key revoked.'); }
      });
      return;
    }
    case 'dismissKey':
      ui.revealedKey = null;
      render();
      return;
    case 'storageIndex':
      go('storageIndex');
      return;
    case 'storageOpenBucket': {
      const b = bucket(id);
      if (!b) return;
      ui.storageBucketId = id;
      ui.storagePrefix = '';
      ui.storageSearch = '';
      go('service', null, b.storageId, 'files');
      return;
    }
    case 'storagePrefix': {
      const p = el.dataset.prefix || '';
      if (!storageSafePrefix(p)) { flash('Invalid prefix.', true); return; }
      ui.storagePrefix = p;
      ui.storageSearch = '';
      render();
      return;
    }
    case 'storageInspect':
      openModal('storageInspect', { objectId: id });
      return;
    case 'storageDeleteObject': {
      const obj = state.objects.find((o) => o.id === id);
      if (!obj) return;
      if (!confirm('Remove this simulated object metadata? (No real file exists.)')) return;
      void apply('objectDelete', { objectId: id }).then((ok) => {
        if (ok) { render(); flash('Demo object metadata removed.'); }
      });
      return;
    }
    case 'storageRevokeGrant': {
      if (!confirm('Revoke this simulated bucket access grant?')) return;
      void apply('storageRevokeGrant', { grantId: id }).then((ok) => {
        if (ok) { render(); flash('Demo grant revoked.'); }
      });
      return;
    }
    case 'terminalStart': {
      const s = service(ui.serviceId);
      if (!s || s.kind !== 'application' || !terminalAllowed(s)) { flash('Terminal permission denied.', true); return; }
      if (ui.termSession) endTerminalSession('Previous session replaced.');
      const nowMs = Date.now();
      ui.termSession = {
        serviceId: s.id, startedAt: nowMs, expiresAt: nowMs + fiveMinutes,
        entries: [
          { kind: 'system', text: '[SIMULATED] Container-scoped session established. No network connection or real command execution.' },
          { kind: 'system', text: 'Type help to see available preview commands. Session expires automatically in 5 minutes.' }
        ]
      };
      activity('Terminal session started', `${s.name} · role: ${ui.termRole}`, 'system');
      if (termExpiryTimer) clearTimeout(termExpiryTimer);
      termExpiryTimer = setTimeout(() => {
        if ((ui.termSession as { serviceId: string } | null)?.serviceId === s.id) {
          endTerminalSession('Session expired automatically.');
          render();
          flash('Terminal session expired.');
        }
      }, fiveMinutes);
      render();
      return;
    }
    case 'terminalEnd':
      endTerminalSession('Closed by user.');
      render();
      flash('Terminal closed.');
      return;
    case 'terminalExpire':
      endTerminalSession('Simulated timeout.');
      render();
      flash('Session expired.');
      return;
    case 'terminalClear':
      if (ui.termSession) { (ui.termSession as { entries: unknown[] }).entries = []; render(); }
      return;
    case 'terminalFill': {
      const input = document.getElementById('terminalCommand') as HTMLInputElement | null;
      if (input) { input.value = el.dataset.command || ''; input.focus(); }
      return;
    }
    case 'terminalCopy': {
      const entries = (ui.termSession as { entries: { text: string }[] } | null)?.entries || [];
      const value = entries.map((e) => e.text).join('\n');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => flash('Transcript copied.')).catch(() => flash('Clipboard unavailable.', true));
      } else flash('Clipboard unavailable.', true);
      return;
    }
    case 'sqlFill': {
      ui.sqlDraft = el.dataset.query || '';
      const input = document.getElementById('sqlQuery') as HTMLTextAreaElement | null;
      if (input) { input.value = ui.sqlDraft; input.focus(); }
      return;
    }
    case 'dnsModeChange':
      openModal('dnsModeChange', { zoneId: id });
      return;
    case 'cancelDnsTransition': {
      void apply('dnsModeCancel', { zoneId: id }).then((ok) => {
        if (ok) { render(); flash('Pending DNS transition cancelled.'); }
      });
      return;
    }
    case 'copyDnsChecklist': {
      const z = domainZone(id);
      if (z) void copyText(dnsChecklist(z));
      return;
    }
    case 'designPalette': {
      const palette = el.dataset.palette;
      if (CLOUDLANE_PALETTES.some((p) => p[0] === palette)) chooseCloudlaneAppearance({ palette });
      return;
    }
    case 'designMode': {
      const mode = el.dataset.mode;
      if (mode === 'dark' || mode === 'light') chooseCloudlaneAppearance({ mode });
      return;
    }
    default:
      break;
  }
}

/* ── form submits ── */
async function handleSubmit(e: Event): Promise<void> {
  const form = e.target as HTMLFormElement;
  if (form.id === 'assistantForm') {
    e.preventDefault();
    const prompt = (form.elements.namedItem('query') as HTMLTextAreaElement)?.value.trim() || '';
    if (!prompt) { flash('Enter a request for the assistant.', true); return; }
    ui.assistantText = prompt;
    ui.assistantPlan = aiCreatePlan(prompt);
    render();
    return;
  }
  if (form.id === 'terminalDemoForm') {
    e.preventDefault();
    runDemoCommand((form.elements.namedItem('command') as HTMLInputElement)?.value || '');
    return;
  }
  if (form.id === 'sqlConsoleForm') {
    e.preventDefault();
    runDemoSql((form.elements.namedItem('query') as HTMLTextAreaElement)?.value || '');
    return;
  }
  e.preventDefault();
  if (!form.reportValidity()) return;
  const data = formData(form);
  switch (form.id) {
    case 'projectForm': {
      const name = String(data.name || '').trim();
      if (name.length < 2) { flash('Project name must have at least 2 characters.', true); return; }
      if (await apply('createProject', { name })) {
        ui.modal = null;
        const p = state.projects[state.projects.length - 1];
        flash(`Created ${name}`);
        go('project', p?.id ?? null);
      }
      break;
    }
    case 'deployForm':
      ui.modalData.projectId = data.projectId;
      if (ui.modalData.source === 'github') {
        const repo = String(data.repo || '').trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { flash('Enter a repository like owner/project.', true); return; }
        if (!state.githubConnected) { flash('Connect the GitHub demo account first.', true); return; }
        const ok = await apply('createGithubApp', {
          projectId: data.projectId, newProjectName: data.newProjectName,
          name: data.name, repo, branch: String(data.branch || 'main'),
          autoDeploy: !!data.autoDeploy, framework: data.framework,
        });
        if (ok) {
          ui.modal = null;
          const s = state.services.find((x) => x.repo === repo && x.name === String(data.name));
          flash('Deployment started. Watch its progress in Deployments.');
          go('service', null, s?.id ?? null, 'deployments');
        }
      } else {
        await deployFromZip(data);
      }
      break;
    case 'databaseForm':
      if (await apply('createDatabase', data)) {
        ui.modal = null;
        flash('Database provisioned.');
        const s = state.services.find((x) => x.kind === 'database' && x.name === String(data.name));
        go('service', null, s?.id ?? null);
      }
      break;
    case 'cronForm':
      if (await apply('createCron', data)) {
        ui.modal = null;
        flash('Scheduled job created.');
        const s = state.services.find((x) => x.kind === 'cron' && x.name === String(data.name));
        go('service', null, s?.id ?? null);
      }
      break;
    case 'domainRegistryForm':
      if (await apply('registerDomain', { domain: data.domain })) {
        ui.modal = null;
        const z = state.domainZones.find((x) => x.name === String(data.domain).toLowerCase().trim());
        go('domainDetail', z?.id ?? null, null, 'overview');
        flash('Domain added. DNS verification is available under DNS Records; DNS management is in Settings.');
      }
      break;
    case 'domainAttachForm':
      if (await apply('bindDomain', { hostnameId: data.hostnameId, serviceId: data.serviceId })) {
        ui.modal = null;
        flash('Domain connected — route activated and HTTPS certificate issued automatically.');
        const h = state.hostnames.find((x) => x.id === String(data.hostnameId));
        if (h?.serviceId) go('service', null, h.serviceId, 'domains');
        else render();
      }
      break;
    case 'subdomainForm':
      if (await apply('createSubdomain', { zoneId: data.zoneId, prefix: data.prefix })) {
        ui.modal = null;
        flash(`${String(data.prefix).toLowerCase()}.${domainZone(String(data.zoneId))?.name} is available for assignment.`);
        go('domainDetail', String(data.zoneId), null, 'subdomains');
      }
      break;
    case 'dnsRecordForm':
      if (await apply('saveDnsRecord', data)) {
        ui.modal = null;
        flash('DNS record saved.');
        go('domainDetail', String(data.zoneId), null, 'dns-records');
      }
      break;
    case 'mailboxForm':
      if (await apply('createMailbox', { zoneId: data.zoneId, local: data.local, quota: data.quota })) {
        ui.modal = null;
        flash('Demo mailbox created. No emails are sent or received.');
        go('domainDetail', String(data.zoneId), null, 'email');
      }
      break;
    case 'aliasForm':
      if (await apply('createAlias', { zoneId: data.zoneId, local: data.local, target: data.target })) {
        ui.modal = null;
        flash('Alias created in demo.');
        go('domainDetail', String(data.zoneId), null, 'email');
      }
      break;
    case 'variableForm': {
      const s = service((ui.modalData.serviceId as string) || (ui.serviceId as string));
      if (!s) { flash('Service not found.', true); return; }
      if (await apply('addVar', { serviceId: s.id, key: data.key, value: data.value })) {
        ui.modal = null;
        flash('Variable saved.');
        render();
      }
      break;
    }
    case 'accessForm':
      if (await apply('dbAccessEnable', { serviceId: ui.modalData.serviceId, allowedIp: String(data.allowedIp || '').trim() })) {
        ui.modal = null;
        flash('Restricted access enabled.');
        render();
      }
      break;
    case 'workspaceForm': {
      const n = String(data.workspace || '').trim();
      if (!n) return;
      if (await apply('renameWorkspace', { name: n })) {
        flash('Workspace renamed.');
        render();
      }
      break;
    }
    case 'dbUserAddForm': {
      const db = service(String(data.serviceId));
      const username = String(data.username || '').trim();
      if (!db || db.kind !== 'database') { flash('Choose a database.', true); return; }
      if (await apply('dbUserAdd', { serviceId: db.id, username, preset: data.preset })) {
        ui.modal = null;
        ui.tab = 'users';
        render();
        flash('Database user created.');
      }
      break;
    }
    case 'dbPrivilegesForm': {
      const checked = [...form.querySelectorAll('input[name="privilege"]:checked')].map((el) => (el as HTMLInputElement).value);
      if (await apply('dbPrivileges', { userId: data.userId, privileges: checked })) {
        ui.modal = null;
        ui.tab = 'users';
        render();
        flash('Privileges updated.');
      }
      break;
    }
    case 'apiKeyForm': {
      const name = String(data.name || '').trim();
      if (!name) { flash('Enter a key name.', true); return; }
      if (await apply('apiKeyCreate', { name, scope: data.scope })) {
        ui.modal = null;
        ui.settingsTab = 'api';
        render();
        flash('Nonfunctional demo key generated.');
      }
      break;
    }
    case 'storageCreateForm': {
      if (await apply('createStorage', data)) {
        ui.modal = null;
        ui.storageBucketId = null;
        const s = state.services.find((x) => x.kind === 'storage' && x.name === String(data.name));
        go('service', null, s?.id ?? null, 'overview');
        flash('Demo storage created. Add a private bucket to begin.');
      }
      break;
    }
    case 'bucketCreateForm':
      if (await apply('bucketCreate', { storageId: data.storageId, name: data.name, purpose: data.purpose, maxMB: data.maxMB })) {
        ui.modal = null;
        const b = state.buckets.find((x) => x.name === String(data.name));
        ui.storageBucketId = b?.id ?? null;
        ui.storagePrefix = '';
        ui.tab = 'buckets';
        render();
        flash('Private bucket created.');
      }
      break;
    case 'storageFolderForm':
      if (await apply('storageFolderCreate', { bucketId: data.bucketId, name: data.name, prefix: data.prefix })) {
        ui.modal = null;
        render();
        flash('Demo folder created.');
      }
      break;
    case 'objectUploadForm': {
      const b = bucket(String(data.bucketId));
      const file = (form.elements.namedItem('file') as HTMLInputElement)?.files?.[0];
      if (!b || !file) { flash('Choose a file.', true); return; }
      const name = file.name.split(/[\\/]/).pop() || '';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,119}$/.test(name) || name.includes('..')) { flash('Use a simple filename without path components.', true); return; }
      const key = String(ui.storagePrefix || '') + name;
      if (await apply('objectUpload', { bucketId: b.id, key, size: file.size, type: file.type || 'application/octet-stream' })) {
        ui.modal = null;
        render();
        flash('File metadata recorded only. No bytes were uploaded.');
      }
      break;
    }
    case 'storageGrantForm':
      if (await apply('storageGrant', { storageId: data.storageId, bucketId: data.bucketId, serviceId: data.serviceId, scope: data.scope })) {
        ui.modal = null;
        ui.tab = 'access';
        render();
        flash('Scoped storage grant recorded (demo).');
      }
      break;
    case 'volumeCreateForm':
      if (await apply('volumeCreate', { serviceId: data.serviceId, name: data.name, mount: data.mount, quotaMB: Number(data.quotaMB) })) {
        ui.modal = null;
        ui.tab = 'volumes';
        render();
        flash('Allocated a simulated named volume.');
      }
      break;
    case 'dnsModeChangeForm':
      if (await apply('dnsModePrepare', { zoneId: data.zoneId, target: data.target })) {
        ui.modal = null;
        go('domainDetail', String(data.zoneId), null, 'settings');
        flash('Transition plan saved. Review setup instructions before confirming.');
      }
      break;
  }
}

/* ── render + mount ── */
function render(): void {
  const root = document.getElementById('app');
  if (!root) return;
  if (!loaded) {
    root.innerHTML = '<div style="display:grid;place-items:center;min-height:60vh"><p class="muted small">Loading workspace…</p></div>';
    return;
  }
  const pageFns: Record<string, () => string> = {
    overview, projects: projectsView, project: projectView, service: serviceView,
    databases: () => servicesIndex('database'), cron: () => servicesIndex('cron'),
    domains: domainsView, domainDetail: domainDetailView, email: emailView,
    servers: serversView, activity: activityView, settings: settingsView,
    storageIndex: storageOverview, docs: docsView,
  };
  const page = (pageFns[ui.page as string] || overview)();
  root.innerHTML =
    `<div class="mobile-shade ${ui.mobileMenu ? 'open' : ''}" data-action="mobileMenu"></div><div class="app">${sidebar()}<main class="main">${header()}<div class="content">${page}</div></main></div>${ui.modal ? modalView() : ''}`;
  renderToast();
  const fab = root.querySelector('.ai-fab') as HTMLElement | null;
  if (!fab) {
    const el = document.createElement('button');
    el.className = 'ai-fab';
    el.dataset.action = 'assistantOpen';
    el.innerHTML = ico('sparkles', 18);
    el.title = 'Drag to move · Tap to open Cloudlane Assistant';
    el.setAttribute('aria-label', 'Open Cloudlane Assistant (drag to reposition)');
    el.setAttribute('aria-haspopup', 'dialog');
    root.appendChild(el);
    root.insertAdjacentHTML('beforeend', assistantPane());
  }
  placeAssistant();
}

/* Assistant fab placement + drag (v1.12) */
const CLOUDLANE_ASSISTANT_POS_KEY = 'cloudlane-assistant-position-v112';
let cloudlaneAssistantSavedPosition: { x: number; y: number } | null = null;
try {
  const raw = localStorage.getItem(CLOUDLANE_ASSISTANT_POS_KEY);
  if (raw) {
    const point = JSON.parse(raw);
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) cloudlaneAssistantSavedPosition = point;
  }
} catch (_) {}
const clampAssistant = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));
function placeAssistant(): void {
  const fab = document.querySelector('.ai-fab') as HTMLElement | null;
  if (!fab) return;
  if (cloudlaneAssistantSavedPosition) {
    const rect = fab.getBoundingClientRect();
    const margin = 10;
    const rx = Math.max(0, innerWidth - rect.width - margin * 2);
    const ry = Math.max(0, innerHeight - rect.height - margin * 2);
    const x = clampAssistant(margin + cloudlaneAssistantSavedPosition.x * rx, margin, innerWidth - rect.width - margin);
    const y = clampAssistant(margin + cloudlaneAssistantSavedPosition.y * ry, margin, innerHeight - rect.height - margin);
    fab.style.left = x + 'px';
    fab.style.top = y + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }
}
let fabDrag: { fab: HTMLElement; id: number; originX: number; originY: number; x: number; y: number; moved: boolean } | null = null;
let ignoreFabClick = false;
function onPointerDown(e: PointerEvent): void {
  const fab = (e.target as HTMLElement).closest('.ai-fab') as HTMLElement | null;
  if (!fab || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const r = fab.getBoundingClientRect();
  fabDrag = { fab, id: e.pointerId, originX: e.clientX, originY: e.clientY, x: r.left, y: r.top, moved: false };
  try { fab.setPointerCapture(e.pointerId); } catch (_) {}
}
function onPointerMove(e: PointerEvent): void {
  const d = fabDrag;
  if (!d || d.id !== e.pointerId) return;
  const dx = e.clientX - d.originX, dy = e.clientY - d.originY;
  if (!d.moved && Math.hypot(dx, dy) < 5) return;
  d.moved = true;
  const margin = 10;
  const r = d.fab.getBoundingClientRect();
  const x = clampAssistant(d.x + dx, margin, innerWidth - r.width - margin);
  const y = clampAssistant(d.y + dy, margin, innerHeight - r.height - margin);
  d.fab.style.left = x + 'px';
  d.fab.style.top = y + 'px';
  d.fab.style.right = 'auto';
  d.fab.style.bottom = 'auto';
  e.preventDefault();
}
function endFabDrag(e: PointerEvent): void {
  const d = fabDrag;
  if (!d || d.id !== e.pointerId) return;
  fabDrag = null;
  try { if (d.fab.hasPointerCapture(e.pointerId)) d.fab.releasePointerCapture(e.pointerId); } catch (_) {}
  if (!d.moved) return;
  const r = d.fab.getBoundingClientRect();
  const margin = 10;
  const rx = Math.max(1, innerWidth - r.width - margin * 2);
  const ry = Math.max(1, innerHeight - r.height - margin * 2);
  cloudlaneAssistantSavedPosition = {
    x: clampAssistant((r.left - margin) / rx, 0, 1),
    y: clampAssistant((r.top - margin) / ry, 0, 1),
  };
  try { localStorage.setItem(CLOUDLANE_ASSISTANT_POS_KEY, JSON.stringify(cloudlaneAssistantSavedPosition)); } catch (_) {}
  ignoreFabClick = true;
  setTimeout(() => { ignoreFabClick = false; }, 320);
}
function onFabClickCapture(e: Event): void {
  if (!ignoreFabClick || !(e.target as HTMLElement).closest('.ai-fab')) return;
  ignoreFabClick = false;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!el) return;
  if (el.matches('button')) e.preventDefault();
  doAction(el.dataset.action || '', el, e);
}
function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui.modal) {
    ui.modal = null;
    ui.modalData = {};
    render();
  }
  if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).matches('[role="button"][data-action]')) {
    e.preventDefault();
    const el = e.target as HTMLElement;
    doAction(el.dataset.action || '', el, e);
  }
}
async function onChange(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement;
  if (target.id === 'mailDomain') {
    const z = domainZone(target.value);
    const suffix = document.getElementById('mailSuffix');
    if (suffix && z) suffix.textContent = '@' + z.name;
    return;
  }
  if (target.id === 'projectId' && ['deploy', 'database', 'cron'].includes(String(ui.modal))) {
    const row = document.getElementById('inlineProjectRow');
    const inp = document.getElementById('newProjectName') as HTMLInputElement | null;
    if (row) {
      row.hidden = target.value !== '__new__';
      if (inp) inp.required = target.value === '__new__';
    }
    ui.modalData.projectId = target.value;
    return;
  }
  if (target.id === 'zipfile') {
    snapshotDeployForm();
    const file = target.files?.[0];
    if (!file) return;
    try {
      const r = await inspectZip(file);
      ui.modalData.fileObj = file;
      ui.modalData.fileName = file.name;
      ui.modalData.detected = r.framework;
      ui.modalData.fileCount = r.count;
      render();
      flash(`ZIP inspected: ${r.framework} detected (${r.count} entries).`);
    } catch (err) {
      ui.modalData.fileObj = null;
      ui.modalData.fileName = '';
      render();
      flash((err as Error).message, true);
    }
    return;
  }
  if (target.id === 'terminalDemoRole') {
    const role = target.value;
    if (!['viewer', 'developer', 'admin'].includes(role)) return;
    if (ui.termSession) endTerminalSession('Permission context changed.');
    ui.termRole = role;
    render();
    return;
  }
  if (target.id === 'storageBucketSelect') {
    const b = bucket(target.value);
    if (!b) return;
    ui.storageBucketId = b.id;
    ui.storagePrefix = '';
    ui.storageSearch = '';
    render();
  }
  if (target.id === 'storageProject') {
    const newProject = target.value === '__new__';
    const row = document.getElementById('storageNewProject');
    if (row) {
      row.hidden = !newProject;
      const inp = row.querySelector('input') as HTMLInputElement | null;
      if (inp) inp.required = newProject;
    }
  }
}
function onInput(e: Event): void {
  const target = e.target as HTMLInputElement;
  if (target.id === 'projectSearch') {
    ui.search = target.value;
    const el = document.getElementById('projectResults');
    if (!el) return;
    const term = String(ui.search).toLowerCase().trim();
    const list = state.projects.filter((p) => p.name.toLowerCase().includes(term));
    el.innerHTML = list.map(projectCard).join('') ||
      '<div class="card empty"><h3>No projects found</h3><p>Try another name.</p></div>';
  }
  if (target.id === 'assistantQuery') ui.assistantText = target.value;
  if (target.id === 'sqlQuery') ui.sqlDraft = target.value;
  if (target.id === 'storageSearch') {
    ui.storageSearch = target.value;
    const pos = target.selectionStart;
    render();
    const inp = document.getElementById('storageSearch') as HTMLInputElement | null;
    if (inp) { inp.focus(); inp.setSelectionRange(pos ?? 0, pos ?? 0); }
  }
}
function onDragOver(e: DragEvent): void {
  const z = (e.target as HTMLElement).closest('#zipzone');
  if (z) { e.preventDefault(); z.classList.add('drag'); }
}
function onDragLeave(e: DragEvent): void {
  const z = (e.target as HTMLElement).closest('#zipzone');
  if (z) z.classList.remove('drag');
}
async function onDrop(e: DragEvent): Promise<void> {
  const z = (e.target as HTMLElement).closest('#zipzone');
  if (!z) return;
  e.preventDefault();
  snapshotDeployForm();
  z.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    const r = await inspectZip(file);
    ui.modalData.fileObj = file;
    ui.modalData.fileName = file.name;
    ui.modalData.detected = r.framework;
    ui.modalData.fileCount = r.count;
    render();
    flash(`ZIP inspected: ${r.framework} detected.`);
  } catch (err) {
    flash((err as Error).message, true);
  }
}
function onPopState(): void {
  const r = parsePath(window.location.pathname);
  ui.page = r.page;
  ui.projectId = r.page === 'domainDetail' ? null : r.pId;
  ui.domainZoneId = r.page === 'domainDetail' ? r.pId : null;
  ui.serviceId = r.sId;
  ui.tab = r.tab ?? 'overview';
  ui.modal = null;
  render();
}

/**
 * SvelteKit's router intercepts plain GET <form> submissions on document
 * (capture) and turns them into navigations, which killed every modal form in
 * the ported UI. A window-capture listener runs before any document listener,
 * so we own the event first: prevent the navigation, stop the router, and run
 * the prototype's submit handler.
 */
function captureSubmit(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
  void handleSubmit(e);
}

export function mountApp(): () => void {
  applyCloudlaneAppearance();
  void syncState().then(() => {
    const r = parsePath(window.location.pathname);
    const q = new URLSearchParams(window.location.search);
    ui.page = r.page;
    ui.projectId = r.page === 'domainDetail' ? null : r.pId;
    ui.domainZoneId = r.page === 'domainDetail' ? r.pId : null;
    ui.serviceId = r.sId;
    ui.tab = r.tab ?? (q.get('tab') ?? 'overview');
    if (ui.page === 'settings' && q.get('tab')) ui.settingsTab = String(q.get('tab'));
    render();
  });
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', endFabDrag);
  document.addEventListener('pointercancel', endFabDrag);
  document.addEventListener('click', onFabClickCapture, true);
  window.addEventListener('submit', captureSubmit, true);
  window.addEventListener('resize', placeAssistant);
  window.addEventListener('popstate', onPopState);
  pollTimer = setInterval(() => {
    // Real deployments progress server-side: poll while any is non-final.
    const busy = state.deployments.some((d) => !['LIVE', 'FAILED', 'CANCELLED'].includes(d.status) && !d.simulating);
    if (busy) void syncState().then(render);
  }, 2500);
  return () => {
    document.removeEventListener('click', onClick);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('change', onChange);
    document.removeEventListener('input', onInput);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', endFabDrag);
    document.removeEventListener('pointercancel', endFabDrag);
    document.removeEventListener('click', onFabClickCapture, true);
    window.removeEventListener('submit', captureSubmit, true);
    window.removeEventListener('resize', placeAssistant);
    window.removeEventListener('popstate', onPopState);
    for (const t of activeTimers.values()) clearInterval(t);
    activeTimers.clear();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (termExpiryTimer) clearTimeout(termExpiryTimer);
    termExpiryTimer = null;
  };
}
