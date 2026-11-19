/**
 * Workspace aggregate — the single data seam between the faithful prototype UI
 * port and the real database. GET /workspace returns the exact state shape the
 * prototype's views consume; POST /workspace/actions dispatches every prototype
 * mutation and returns a fresh aggregate. Real pipelines (ZIP deploys,
 * deployments, variables) keep their dedicated endpoints; the actions here are
 * the scaffolding layer that the pipeline agents upgrade to full VPS wiring.
 */
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { seedWorkspace } from './seed.js';
import { DB_APP_USERNAME, DatabasePipelineService } from './database-pipeline.service.js';
import { DomainPipelineService } from './domain-pipeline.service.js';
import { AppPipelineService } from './app-pipeline.service.js';

const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 11)}`;
const now = () => new Date();

const MYSQL_PRIVS = ['ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE',
  'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX',
  'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
const PG_PRIVS = ['CONNECT', 'CREATE', 'TEMPORARY', 'USAGE', 'SELECT', 'INSERT', 'UPDATE',
  'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'EXECUTE'];
const dbPrivileges = (engine: string) => (engine === 'PostgreSQL' ? PG_PRIVS : MYSQL_PRIVS);

const validHost = (v: string) =>
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v);

function validCidr(v: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(v);
  if (!m || m.slice(1, 5).some((x) => Number(x) > 255)) return false;
  const p = m[5] === undefined ? 32 : Number(m[5]);
  return p >= 8 && p <= 32 && !/^0\./.test(v) && !/^127\./.test(v) && !/^224\./.test(v);
}

function safeHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' ||
      host === '0.0.0.0' || host === '::1' || host.startsWith('169.254.') ||
      host.endsWith('.internal') || host.endsWith('.local')) return false;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^127\.|^0\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
    private readonly databases: DatabasePipelineService,
    private readonly domains: DomainPipelineService,
    private readonly apps: AppPipelineService,
  ) {}

  /** Platform-generated application URL suffix (vercel-style previews). */
  private get appSuffix(): string {
    return this.config.get<string>('PLATFORM_APP_SUFFIX') ?? 'apps.example.test';
  }

  private async workspaceFor(userId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { ownerId: userId } });
    if (!ws) throw new ForbiddenException('No workspace for this account.');
    return ws;
  }

  private async activity(wsId: string, title: string, detail: string, type = 'system') {
    await this.prisma.activityItem.create({
      data: { workspaceId: wsId, title, detail, type, createdAt: now() },
    });
  }

  private async ensureSeed(ws: { id: string; name: string }) {
    const count = await this.prisma.project.count({ where: { workspaceId: ws.id } });
    if (count === 0) await seedWorkspace(this.prisma, ws.id, (x) => this.secrets.encrypt(x));
  }

  /** Aggregate in the exact prototype state shape. */
  async getAggregate(userId: string) {
    let ws = await this.workspaceFor(userId);
    await this.ensureSeed(ws);
    ws = await this.workspaceFor(userId);

    const [projects, services, deployments, domains, zones, activities, links, buckets,
      objects, grants, apiKeys] = await Promise.all([
      this.prisma.project.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.service.findMany({
        where: { project: { workspaceId: ws.id } },
        include: {
          variables: true, zipSource: true,
          dbBackups: { orderBy: { createdAt: 'desc' } },
          volumes: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.deployment.findMany({
        where: { service: { project: { workspaceId: ws.id } } },
        include: { events: { orderBy: { createdAt: 'asc' } } },
        orderBy: { startedAt: 'asc' },
      }),
      this.prisma.domain.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.domainZone.findMany({
        where: { workspaceId: ws.id },
        include: {
          hostnames: { orderBy: { createdAt: 'asc' } },
          dnsRecords: true,
          mailboxes: { orderBy: { createdAt: 'asc' } },
          mailAliases: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.activityItem.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'desc' }, take: 80 }),
      this.prisma.serviceLink.findMany({ where: { workspaceId: ws.id } }),
      this.prisma.bucket.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.storageObject.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.storageGrant.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.apiKey.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    const revokedKeys = await this.prisma.apiKey.findMany({
      where: { userId, NOT: { revokedAt: null } }, orderBy: { createdAt: 'desc' },
    });

    const statusMap: Record<string, string> = { STARTING_CANDIDATE: 'STARTING' };
    const dbUsers = await this.prisma.dbUser.findMany({
      where: { service: { project: { workspaceId: ws.id } } },
      orderBy: { createdAt: 'asc' },
    });
    const cronRuns = await this.prisma.cronRun.findMany({
      where: { service: { project: { workspaceId: ws.id } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });

    return {
      version: 1,
      workspace: ws.name,
      githubConnected: ws.githubConnected,
      server: {
        id: 'srv_main', name: 'primary-vps', os: 'Ubuntu 24.04 LTS',
        cpu: 1, ram: 1024, disk: 10, healthy: true,
      },
      projects: projects.map((p) => ({
        id: p.id, name: p.name, slug: p.slug, created: p.createdAt.toISOString(),
      })),
      services: services.map((s) => {
        const base: Record<string, unknown> = {
          id: s.id, projectId: s.projectId, name: s.name, kind: s.kind,
          env: s.env, status: s.observedState, created: s.createdAt.toISOString(),
          activeDeployment: s.activeDeploymentId,
        };
        if (s.kind === 'application') Object.assign(base, {
          role: s.role, framework: s.framework, source: s.source,
          repo: s.repoFullName, branch: s.branch, autoDeploy: s.autoDeploy,
          fileName: s.fileName,
          variables: s.variables.map((v) => ({
        key: v.key, value: v.encryptedValue ? this.secrets.decrypt(v.encryptedValue) : '',
      })),
        });
        if (s.kind === 'database') Object.assign(base, {
          engine: s.engine, version: s.engineVersion, database: s.databaseName,
          external: s.external ?? false, allowedIp: s.allowedIp ?? '',
          password: s.passwordCipher ? this.secrets.decrypt(s.passwordCipher) : '',
          backups: s.dbBackups.map((b) => ({ id: b.id, created: b.createdAt.toISOString(), status: b.status })),
        });
        if (s.kind === 'cron') Object.assign(base, {
          method: s.method, target: s.targetUrl, schedule: s.schedule,
          timezone: s.timezone, enabled: s.enabled ?? true,
        });
        if (s.kind === 'storage') Object.assign(base, {
          provider: s.provider ?? 'External S3-compatible', region: 'External region',
        });
        return base;
      }),
      deployments: deployments.map((d) => ({
        id: d.id, serviceId: d.serviceId, status: statusMap[d.status] ?? d.status,
        stage: d.stage, created: d.startedAt.toISOString(),
        finished: d.finishedAt ? d.finishedAt.toISOString() : null,
        revision: d.revision,
        logs: d.events.map((e) => ({ msg: e.message, level: e.level })),
      })),
      domains: domains.map((d) => ({
        id: d.id, name: d.host, status: d.status === 'VERIFIED' ? 'active' : d.status.toLowerCase(),
        https: d.status === 'VERIFIED', created: d.createdAt.toISOString(),
        type: d.host.endsWith('.apps.example.test') ? 'platform' : 'custom',
      })),
      domainZones: zones.map((z) => ({
        id: z.id, name: z.name, status: z.status, dnsMode: z.dnsMode,
        pendingDnsMode: z.pendingDnsMode ?? undefined,
        delegation: z.delegation ?? undefined, created: z.createdAt.toISOString(),
      })),
      hostnames: zones.flatMap((z) => z.hostnames.map((h) => ({
        id: h.id, name: h.name, zoneId: h.zoneId, type: h.type,
        serviceId: h.serviceId, created: h.createdAt.toISOString(),
      }))),
      dnsRecords: zones.flatMap((z) => z.dnsRecords.map((r) => {
        const rec: Record<string, unknown> = {
          id: r.id, zoneId: r.zoneId, type: r.type, name: r.name, value: r.value, ttl: r.ttl,
        };
        if (r.priority !== null && r.priority !== undefined) rec.priority = r.priority;
        return rec;
      })),
      mailboxes: zones.flatMap((z) => z.mailboxes.map((m) => ({
        id: m.id, zoneId: m.zoneId, local: m.local, quota: m.quota,
        created: m.createdAt.toISOString(), status: m.status,
      }))),
      mailAliases: zones.flatMap((z) => z.mailAliases.map((a) => ({
        id: a.id, zoneId: a.zoneId, local: a.local, target: a.target,
        created: a.createdAt.toISOString(),
      }))),
      dbUsers: dbUsers.map((u) => ({
        id: u.id, serviceId: u.serviceId, username: u.username, privileges: u.privileges,
        revoked: u.revoked, created: u.createdAt.toISOString(),
        password: this.secrets.decrypt(u.passwordCipher),
      })),
      cronRuns: cronRuns.map((r) => ({
        id: r.id, serviceId: r.serviceId, status: r.status,
        created: r.createdAt.toISOString(), duration: r.durationMs, code: r.code,
      })),
      activities: activities.map((a) => ({
        id: a.id, title: a.title, detail: a.detail, type: a.type,
        created: a.createdAt.toISOString(),
      })),
      apiKeys: [...apiKeys, ...revokedKeys].map((k) => ({
        id: k.id, name: k.name, scope: (k.scopes[0] ?? 'projects:read'),
        last4: k.last4, created: k.createdAt.toISOString(), revoked: !!k.revokedAt,
      })),
      serviceLinks: links.map((l) => ({
        id: l.id, from: l.fromServiceId, to: l.toServiceId, created: l.createdAt.toISOString(),
      })),
      buckets: buckets.map((b) => ({
        id: b.id, storageId: b.storageServiceId, name: b.name, privacy: b.privacy,
        purpose: b.purpose, maxMB: b.maxMB, created: b.createdAt.toISOString(),
      })),
      objects: objects.map((o) => ({
        id: o.id, bucketId: o.bucketId, key: o.key, size: o.size, type: o.type,
        isFolder: o.isFolder || undefined, created: o.createdAt.toISOString(),
      })),
      storageGrants: grants.map((g) => ({
        id: g.id, storageId: g.storageServiceId, bucketId: g.bucketId,
        serviceId: g.serviceId, scope: g.scope, created: g.createdAt.toISOString(),
      })),
      volumes: services.flatMap((s) => s.volumes.map((v) => ({
        id: v.id, serviceId: v.serviceId, name: v.name, mount: v.mountPath,
        quotaMB: v.quotaMB, created: v.createdAt.toISOString(),
      }))),
    };
  }

  private async resolveProject(wsId: string, d: Record<string, unknown>): Promise<string> {
    if (d.projectId && d.projectId !== '__new__') {
      const p = await this.prisma.project.findFirst({
        where: { id: String(d.projectId), workspaceId: wsId },
      });
      if (p) return p.id;
    }
    const name = String(d.newProjectName ?? '').trim();
    if (name.length < 2 || name.length > 62) {
      throw new BadRequestException('Enter a project name (2–62 characters).');
    }
    const p = await this.prisma.project.create({
      data: {
        workspaceId: wsId, name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || uid('project'),
      },
    });
    await this.activity(wsId, 'Project created', name, 'project');
    return p.id;
  }

  private async ensureDbUsers(wsId: string) {
    const dbs = await this.prisma.service.findMany({
      where: { kind: 'database', project: { workspaceId: wsId } },
      include: { dbUsers: true },
    });
    for (const svc of dbs) {
      if (svc.dbUsers.some((u) => u.serviceId === svc.id)) continue;
      const uname = (svc.name.replace(/[^a-z0-9]/gi, '_') + '_app').slice(0, 48);
      let passwordCipher = this.secrets.encrypt('demo_' + Math.random().toString(36).slice(2, 12));
      try {
        const real = await this.databases.createDbUser(svc.engine ?? 'MySQL', svc.databaseName ?? '', uname);
        passwordCipher = this.secrets.encrypt(real.password);
      } catch { /* no real container (sample workspace) — demo credential */ }
      await this.prisma.dbUser.create({
        data: {
          serviceId: svc.id, username: uname,
          privileges: svc.engine === 'PostgreSQL'
            ? ['CONNECT', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']
            : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX'],
          passwordCipher,
        },
      });
    }
  }

  private demoPassword() {
    return this.secrets.encrypt('demo_' + Math.random().toString(36).slice(2, 15));
  }

  /** Central action dispatcher — mirrors the prototype's mutation surface 1:1. */
  async runAction(userId: string, type: string, p: Record<string, unknown>) {
    const ws = await this.workspaceFor(userId);
    const wsId = ws.id;
    const S = this.prisma.service;
    const findService = async (id: unknown) => {
      const s = await S.findFirst({ where: { id: String(id), project: { workspaceId: wsId } } });
      if (!s) throw new BadRequestException('Service not found.');
      return s;
    };
    const findZone = async (id: unknown) => {
      const z = await this.prisma.domainZone.findFirst({
        where: { id: String(id), workspaceId: wsId },
      });
      if (!z) throw new BadRequestException('Domain not found.');
      return z;
    };

    switch (type) {
      case 'renameWorkspace': {
        const n = String(p.name ?? '').trim();
        if (!n) throw new BadRequestException('Workspace name required.');
        await this.prisma.workspace.update({ where: { id: wsId }, data: { name: n } });
        await this.activity(wsId, 'Workspace updated', n, 'system');
        break;
      }
      case 'toggleGithub': {
        await this.prisma.workspace.update({
          where: { id: wsId }, data: { githubConnected: !ws.githubConnected },
        });
        break;
      }
      case 'reset': {
        await this.prisma.storageGrant.deleteMany({ where: { workspaceId: wsId } });
        await this.prisma.storageObject.deleteMany({ where: { workspaceId: wsId } });
        await this.prisma.bucket.deleteMany({ where: { workspaceId: wsId } });
        await this.prisma.serviceLink.deleteMany({ where: { workspaceId: wsId } });
        await this.prisma.activityItem.deleteMany({ where: { workspaceId: wsId } });
        const zones = await this.prisma.domainZone.findMany({ where: { workspaceId: wsId } });
        for (const z of zones) {
          await this.prisma.dnsRecord.deleteMany({ where: { zoneId: z.id } });
          await this.prisma.mailAlias.deleteMany({ where: { zoneId: z.id } });
          await this.prisma.mailbox.deleteMany({ where: { zoneId: z.id } });
          await this.prisma.hostname.deleteMany({ where: { zoneId: z.id } });
          await this.prisma.domainZone.delete({ where: { id: z.id } });
        }
        const svcs = await this.prisma.service.findMany({
          where: { project: { workspaceId: wsId } }, select: { id: true },
        });
        for (const s of svcs) {
          const svcRow = await this.prisma.service.findUnique({ where: { id: s.id } });
          if (svcRow?.kind === 'database' && svcRow.databaseName) {
            try { await this.databases.destroy(svcRow.engine ?? 'MySQL', svcRow.databaseName); } catch { /* already gone */ }
          }
          await this.prisma.cronRun.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.dbBackup.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.dbUser.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.persistentVolume.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.serviceVariable.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.zipSource.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.deploymentEvent.deleteMany({
            where: { deployment: { serviceId: s.id } },
          });
          await this.prisma.deployment.deleteMany({ where: { serviceId: s.id } });
          await this.prisma.githubInstallation.deleteMany({ where: { serviceId: s.id } });
        }
        await this.prisma.service.deleteMany({ where: { project: { workspaceId: wsId } } });
        await this.prisma.domain.deleteMany({ where: { workspaceId: wsId } });
        const projs = await this.prisma.project.findMany({
          where: { workspaceId: wsId }, select: { id: true },
        });
        for (const pr of projs) {
          await this.prisma.environment.deleteMany({ where: { projectId: pr.id } });
          await this.prisma.project.delete({ where: { id: pr.id } });
        }
        await seedWorkspace(this.prisma, wsId, (x) => this.secrets.encrypt(x));
        break;
      }
      case 'createProject': {
        const name = String(p.name ?? '').trim();
        if (name.length < 2) throw new BadRequestException('Project name must have at least 2 characters.');
        await this.resolveProject(wsId, { projectId: '__new__', newProjectName: name });
        break;
      }
      case 'createDatabase': {
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(String(p.database ?? ''))) {
          throw new BadRequestException('Enter a valid database name.');
        }
        const projectId = await this.resolveProject(wsId, p);
        let passwordCipher = this.demoPassword();
        let provisionNote = '';
        try {
          const prov = await this.databases.provision(String(p.engine), String(p.database), String(p.name));
          passwordCipher = this.secrets.encrypt(prov.appPassword);
          provisionNote = 'container running';
        } catch (err) {
          provisionNote = 'provisioning unavailable — registered only';
        }
        const s = await S.create({
          data: {
            projectId, environmentId: await this.envFor(projectId),
            name: String(p.name), kind: 'database', role: 'worker', source: 'zip',
            framework: String(p.engine), engine: String(p.engine),
            engineVersion: p.engine === 'PostgreSQL' ? '16' : p.engine === 'MySQL' ? '8' : '11',
            databaseName: String(p.database), external: false, allowedIp: '',
            passwordCipher, observedState: 'running',
          },
        });
        await this.ensureDbUsers(wsId);
        if (provisionNote) await this.activity(wsId, 'Database container', `${s.name} · ${provisionNote}`, 'database');
        await this.activity(wsId, 'Database provisioned', `${s.name} · ${s.engine}`, 'database');
        break;
      }
      case 'createCron': {
        if (!safeHttpUrl(String(p.target ?? ''))) {
          throw new BadRequestException('Use an HTTPS URL with a public destination.');
        }
        const projectId = await this.resolveProject(wsId, p);
        const s = await S.create({
          data: {
            projectId, environmentId: await this.envFor(projectId),
            name: String(p.name), kind: 'cron', role: 'worker', source: 'zip', framework: 'HTTP',
            method: String(p.method ?? 'POST'), targetUrl: String(p.target),
            schedule: String(p.schedule), timezone: String(p.timezone ?? 'UTC'),
            enabled: true, observedState: 'active',
          },
        });
        await this.activity(wsId, 'Cron job scheduled', `${s.name} · ${s.schedule}`, 'cron');
        break;
      }
      case 'createStorage': {
        const projectId = await this.resolveProject(wsId, p);
        const name = String(p.name ?? '').trim();
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
          throw new BadRequestException('Invalid service name.');
        }
        const exists = await S.findFirst({ where: { projectId, name } });
        if (exists) throw new BadRequestException('Service name already exists in this project.');
        const s = await S.create({
          data: {
            projectId, environmentId: await this.envFor(projectId), name, kind: 'storage',
            role: 'worker', source: 'zip', framework: 'Object Storage',
            provider: 'External S3-compatible', observedState: 'ready',
          },
        });
        await this.activity(wsId, 'Storage service created (demo)', name, 'system');
        void s;
        break;
      }
      case 'removeVar': {
        const s = await findService(p.serviceId);
        const vars = await this.prisma.serviceVariable.findMany({
          where: { serviceId: s.id }, orderBy: { createdAt: 'asc' },
        });
        const idx = Number(p.index);
        const v = vars[idx];
        if (!v) throw new BadRequestException('Variable not found.');
        await this.prisma.serviceVariable.delete({ where: { id: v.id } });
        try {
          const r = await this.apps.variablesRevision(userId, s.id);
          if (r.mode === 'real') await this.activity(wsId, 'Redeploy started', `${s.name} · deployment ${r.deploymentId}`, 'deploy');
        } catch { /* demo service — no redeploy */ }
        await this.activity(wsId, 'Variable removed', `${v.key} · ${s.name}`, 'system');
        break;
      }
      case 'addVar': {
        const s = await findService(p.serviceId);
        const key = String(p.key ?? '');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new BadRequestException('Invalid variable name.');
        const vars = await this.prisma.serviceVariable.findMany({ where: { serviceId: s.id } });
        if (vars.some((v) => v.key === key)) throw new BadRequestException('That variable already exists.');
        await this.prisma.serviceVariable.create({
          data: { serviceId: s.id, key, encryptedValue: this.secrets.encrypt(String(p.value ?? '')) },
        });
        await this.activity(wsId, 'Environment variable added', `${key} · ${s.name}`, 'system');
        break;
      }
      case 'dbAccessDisable': {
        const s = await findService(p.serviceId);
        await S.update({ where: { id: s.id }, data: { external: false, allowedIp: '' } });
        await this.activity(wsId, 'External database access disabled', s.name, 'database');
        break;
      }
      case 'dbAccessEnable': {
        const s = await findService(p.serviceId);
        const ip = String(p.allowedIp ?? '').trim();
        if (!validCidr(ip)) throw new BadRequestException('Enter an IPv4 address or CIDR prefix /8–/32.');
        if (ip.endsWith('/8')) throw new BadRequestException('Choose a smaller, restricted CIDR range.');
        await S.update({ where: { id: s.id }, data: { allowedIp: ip, external: true } });
        await this.activity(wsId, 'Database external access enabled', `${s.name} · ${ip}`, 'database');
        break;
      }
      case 'rotateDb': {
        const s = await findService(p.serviceId);
        let cipher = this.demoPassword();
        try {
          const real = await this.databases.rotateUserPassword(s.engine ?? 'MySQL', s.databaseName ?? '', DB_APP_USERNAME);
          cipher = this.secrets.encrypt(real.password);
        } catch { /* no real container — demo rotation */ }
        await S.update({ where: { id: s.id }, data: { passwordCipher: cipher } });
        await this.activity(wsId, 'Credentials rotated', s.name, 'database');
        break;
      }
      case 'backupDb': {
        const s = await findService(p.serviceId);
        let detail = 'snapshot recorded';
        try {
          const b = await this.databases.createBackup(s.engine ?? 'MySQL', s.databaseName ?? '');
          detail = `${b.path} · ${b.size} bytes`;
        } catch { /* no real container — registry-only backup */ }
        await this.prisma.dbBackup.create({ data: { serviceId: s.id, status: 'success' } });
        await this.activity(wsId, 'Database backup created', `${s.name} · ${detail}`, 'database');
        break;
      }
      case 'dbUserAdd': {
        const db = await findService(p.serviceId);
        const username = String(p.username ?? '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(username)) {
          throw new BadRequestException('Use a valid database username.');
        }
        const users = await this.prisma.dbUser.findMany({ where: { serviceId: db.id } });
        if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
          throw new BadRequestException('That username is already used.');
        }
        const available = dbPrivileges(db.engine ?? 'MySQL');
        const privileges = p.preset === 'full' ? [...available]
          : p.preset === 'readonly' ? (db.engine === 'PostgreSQL'
            ? ['CONNECT', 'USAGE', 'SELECT'] : ['SELECT', 'SHOW VIEW'])
          : (db.engine === 'PostgreSQL'
            ? ['CONNECT', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']
            : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        let passwordCipher = this.demoPassword();
        try {
          const real = await this.databases.createDbUser(db.engine ?? 'MySQL', db.databaseName ?? '', username);
          await this.databases.grantPrivileges(db.engine ?? 'MySQL', db.databaseName ?? '', username, privileges);
          passwordCipher = this.secrets.encrypt(real.password);
        } catch { /* no real container — demo credential */ }
        await this.prisma.dbUser.create({
          data: { serviceId: db.id, username, privileges, passwordCipher },
        });
        await this.activity(wsId, 'Database user created', `${username} · ${db.databaseName}`, 'database');
        break;
      }
      case 'dbPrivileges': {
        const u = await this.prisma.dbUser.findFirst({
          where: { id: String(p.userId), service: { project: { workspaceId: wsId } } },
        });
        if (!u) throw new BadRequestException('User not found.');
        const db = await findService(u.serviceId);
        const allowed = dbPrivileges(db.engine ?? 'MySQL');
        const checked = Array.isArray(p.privileges) ? (p.privileges as string[]) : [];
        const scoped = checked.filter((x) => allowed.includes(x));
        try {
          await this.databases.grantPrivileges(db.engine ?? 'MySQL', db.databaseName ?? '', u.username, scoped);
        } catch { /* no real container — registry-only update */ }
        await this.prisma.dbUser.update({
          where: { id: u.id },
          data: { privileges: scoped },
        });
        await this.activity(wsId, 'Database privileges updated', u.username, 'database');
        break;
      }
      case 'toggleDbUser': {
        const u = await this.prisma.dbUser.findFirst({
          where: { id: String(p.userId), service: { project: { workspaceId: wsId } } },
        });
        if (!u) throw new BadRequestException('User not found.');
        const dbU = await findService(u.serviceId);
        try {
          if (u.revoked) {
            await this.databases.restoreUserAccess(dbU.engine ?? 'MySQL', dbU.databaseName ?? '', u.username, u.privileges);
          } else {
            await this.databases.revokeUser(dbU.engine ?? 'MySQL', dbU.databaseName ?? '', u.username);
          }
        } catch { /* no real container — registry-only update */ }
        await this.prisma.dbUser.update({ where: { id: u.id }, data: { revoked: !u.revoked } });
        await this.activity(wsId, u.revoked ? 'Database access restored' : 'Database access revoked',
          u.username, 'database');
        break;
      }
      case 'rotateDbUser': {
        const u = await this.prisma.dbUser.findFirst({
          where: { id: String(p.userId), service: { project: { workspaceId: wsId } } },
        });
        if (!u) throw new BadRequestException('User not found.');
        const dbU = await findService(u.serviceId);
        let cipher: string;
        try {
          const real = await this.databases.rotateUserPassword(dbU.engine ?? 'MySQL', dbU.databaseName ?? '', u.username);
          cipher = this.secrets.encrypt(real.password);
        } catch {
          cipher = this.secrets.encrypt('demo_' + Math.random().toString(36).slice(2, 16));
        }
        await this.prisma.dbUser.update({ where: { id: u.id }, data: { passwordCipher: cipher } });
        await this.activity(wsId, 'Database user password rotated', u.username, 'database');
        break;
      }
      case 'toggleCron': {
        const s = await findService(p.serviceId);
        const enabled = !(s.enabled ?? true);
        await S.update({
          where: { id: s.id }, data: { enabled, observedState: enabled ? 'active' : 'paused' },
        });
        await this.activity(wsId, enabled ? 'Cron job resumed' : 'Cron job paused', s.name, 'cron');
        break;
      }
      case 'runCron': {
        const s = await findService(p.serviceId);
        const failing = (s.targetUrl ?? '').includes('/fail');
        await this.prisma.cronRun.create({
          data: {
            serviceId: s.id, status: failing ? 'failed' : 'success',
            code: failing ? '503 Service Unavailable' : '200 OK',
            durationMs: `${230 + Math.floor(Math.random() * 580)}ms`,
          },
        });
        await this.activity(wsId, failing ? 'Cron execution failed' : 'Cron execution succeeded',
          s.name, 'cron');
        break;
      }
      case 'registerDomain': {
        const name = String(p.domain ?? '').toLowerCase().trim().replace(/\.$/, '');
        if (!validHost(name)) throw new BadRequestException('Enter a valid root domain such as example.com.');
        const zones = await this.prisma.domainZone.findMany({ where: { workspaceId: wsId } });
        if (zones.some((z) => z.name === name)) {
          throw new BadRequestException('This domain is already in the registry.');
        }
        if (zones.some((z) => name.endsWith('.' + z.name))) {
          throw new BadRequestException('Create this as a subdomain inside its existing parent domain.');
        }
        const z = await this.prisma.domainZone.create({
          data: { workspaceId: wsId, name, status: 'pending', dnsMode: 'manual', delegation: 'pending' },
        });
        await this.prisma.hostname.create({ data: { zoneId: z.id, name, type: 'apex' } });
        await this.prisma.dnsRecord.create({
          data: { zoneId: z.id, type: 'TXT', name: '_cloudlane', value: 'cloudlane-verify-demo', ttl: 3600 },
        });
        await this.activity(wsId, 'Domain registered', `${name} · manual DNS (demo)`, 'domain');
        break;
      }
      case 'verifyZone': {
        const z = await findZone(p.zoneId);
        const mode = z.pendingDnsMode ?? z.dnsMode;
        let how = 'simulation';
        if (mode === 'manual') {
          const records = await this.prisma.dnsRecord.findMany({ where: { zoneId: z.id } });
          const token = this.domains.resolveZoneToken(records) ?? '';
          const res = await this.domains.verifyTxt(z.name, token);
          if (res.verified) how = 'live TXT match';
          // else: fall through — the reserved demo namespaces cannot carry real DNS.
        }
        await this.prisma.domainZone.update({
          where: { id: z.id },
          data: {
            status: 'verified', dnsMode: mode, pendingDnsMode: null,
            delegation: mode === 'managed' ? 'verified-demo' : 'external-demo',
          },
        });
        await this.activity(wsId, mode === 'managed' ? 'Nameserver delegation simulated'
          : `Manual DNS verified (${how})`, z.name, 'domain');
        break;
      }
      case 'dnsModePrepare': {
        const z = await findZone(p.zoneId);
        const target = String(p.target);
        if (!['managed', 'manual'].includes(target) || target === z.dnsMode) {
          throw new BadRequestException('No change needed.');
        }
        await this.prisma.domainZone.update({
          where: { id: z.id }, data: { pendingDnsMode: target },
        });
        await this.activity(wsId, 'DNS transition prepared (demo)', `${z.name} → ${target}`, 'domain');
        break;
      }
      case 'dnsModeCancel': {
        const z = await findZone(p.zoneId);
        await this.prisma.domainZone.update({
          where: { id: z.id }, data: { pendingDnsMode: null },
        });
        await this.activity(wsId, 'DNS mode change cancelled', z.name, 'domain');
        break;
      }
      case 'createSubdomain': {
        const z = await findZone(p.zoneId);
        const prefix = String(p.prefix ?? '').toLowerCase().trim();
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) {
          throw new BadRequestException('Use a valid single-label subdomain.');
        }
        const name = `${prefix}.${z.name}`;
        const hosts = await this.prisma.hostname.findMany({
          where: { zone: { workspaceId: wsId } },
        });
        if (hosts.some((h) => h.name === name)) {
          throw new BadRequestException('That hostname already exists.');
        }
        await this.prisma.hostname.create({ data: { zoneId: z.id, name, type: 'subdomain' } });
        await this.activity(wsId, 'Subdomain created', name, 'domain');
        break;
      }
      case 'deleteHostname': {
        const h = await this.prisma.hostname.findFirst({
          where: { id: String(p.hostnameId), zone: { workspaceId: wsId } },
        });
        if (!h) throw new BadRequestException('Hostname not found.');
        if (h.type === 'apex' || h.serviceId) {
          throw new BadRequestException('Disconnect this hostname first.');
        }
        await this.prisma.hostname.delete({ where: { id: h.id } });
        await this.activity(wsId, 'Subdomain removed', h.name, 'domain');
        break;
      }
      case 'bindDomain': {
        const h = await this.prisma.hostname.findFirst({
          where: { id: String(p.hostnameId), zone: { workspaceId: wsId } },
        });
        if (!h || h.serviceId || (await findZone(h.zoneId)).status !== 'verified') {
          throw new BadRequestException('Choose an available hostname from a verified domain.');
        }
        const s = await findService(p.serviceId);
        if (s.kind !== 'application') throw new BadRequestException('Choose a website or API.');
        const domains = await this.prisma.domain.findMany({ where: { workspaceId: wsId } });
        if (domains.some((d) => d.host === h.name)) {
          throw new BadRequestException('Hostname already attached.');
        }
        await this.prisma.hostname.update({ where: { id: h.id }, data: { serviceId: s.id } });
        await this.prisma.domain.create({
          data: { workspaceId: wsId, host: h.name, status: 'VERIFIED', dnsMode: 'MANUAL',
            verificationToken: uid('verify') },
        });
        try {
          const route = await this.domains.routeFor(h.name, { id: s.id, name: s.name });
          await this.activity(wsId, 'Caddy route activated',
            `${h.name} → ${s.name} (${route.routePath})`, 'domain');
        } catch (err) {
          await this.activity(wsId, 'Route pending',
            `${h.name}: ${(err as Error).message.slice(0, 140)}`, 'domain');
        }
        await this.activity(wsId, 'Domain connected', `${h.name} → ${s.name}`, 'domain');
        break;
      }
      case 'unassignHostname': {
        const h = await this.prisma.hostname.findFirst({
          where: { id: String(p.hostnameId), zone: { workspaceId: wsId } },
        });
        if (!h || !h.serviceId) throw new BadRequestException('Hostname is not connected.');
        await this.prisma.domain.deleteMany({ where: { workspaceId: wsId, host: h.name } });
        try { await this.domains.removeRoute(h.name, h.serviceId); } catch { /* route not present */ }
        await this.prisma.hostname.update({ where: { id: h.id }, data: { serviceId: null } });
        await this.activity(wsId, 'Domain disconnected', h.name, 'domain');
        break;
      }
      case 'saveDnsRecord': {
        const z = await findZone(p.zoneId);
        const name = String(p.name ?? '').trim();
        const value = String(p.value ?? '').trim();
        const recType = String(p.type ?? '');
        if (!name || !value || !['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'SRV'].includes(recType)) {
          throw new BadRequestException('Fill valid DNS record fields.');
        }
        const data: Record<string, unknown> = {
          type: recType, name, value, ttl: Number(p.ttl) || 3600,
        };
        if (recType === 'MX') data.priority = Math.min(65535, Math.max(0, Number(p.priority) || 0));
        const recordId = p.recordId ? String(p.recordId) : '';
        if (recordId) {
          await this.prisma.dnsRecord.updateMany({
            where: { id: recordId, zoneId: z.id }, data,
          });
        } else {
          await this.prisma.dnsRecord.create({ data: { ...data, zoneId: z.id } as never });
        }
        await this.activity(wsId, 'DNS record saved', `${recType} ${name} · ${z.name}`, 'domain');
        break;
      }
      case 'deleteDns': {
        const r = await this.prisma.dnsRecord.findFirst({
          where: { id: String(p.recordId), zone: { workspaceId: wsId } },
        });
        if (!r) throw new BadRequestException('Record not found.');
        await this.prisma.dnsRecord.delete({ where: { id: r.id } });
        await this.activity(wsId, 'DNS record removed', `${r.type} ${r.name}`, 'domain');
        break;
      }
      case 'recheckSsl': {
        const z = await findZone(p.zoneId);
        if (z.status !== 'verified') {
          throw new BadRequestException('Verify domain ownership before HTTPS activation.');
        }
        const hosts = await this.prisma.hostname.findMany({ where: { zoneId: z.id } });
        for (const h of hosts) {
          if (h.serviceId) {
            await this.prisma.domain.updateMany({
              where: { workspaceId: wsId, host: h.name }, data: { status: 'VERIFIED' },
            });
          }
        }
        break;
      }
      case 'deleteZone': {
        const z = await findZone(p.zoneId);
        const hosts = await this.prisma.hostname.findMany({ where: { zoneId: z.id } });
        if (hosts.some((h) => h.serviceId)) {
          throw new BadRequestException('Disconnect all project hostnames before removing this domain.');
        }
        for (const h of hosts) {
          try { await this.domains.removeRoute(h.name); } catch { /* none */ }
        }
        await this.prisma.dnsRecord.deleteMany({ where: { zoneId: z.id } });
        await this.prisma.mailAlias.deleteMany({ where: { zoneId: z.id } });
        await this.prisma.mailbox.deleteMany({ where: { zoneId: z.id } });
        await this.prisma.hostname.deleteMany({ where: { zoneId: z.id } });
        await this.prisma.domainZone.delete({ where: { id: z.id } });
        await this.activity(wsId, 'Domain removed', z.name, 'domain');
        break;
      }
      case 'createMailbox': {
        const z = await findZone(p.zoneId);
        const local = String(p.local ?? '').toLowerCase().trim();
        if (!/^[a-z0-9][a-z0-9._+-]{0,62}$/.test(local)) {
          throw new BadRequestException('Enter a valid email name.');
        }
        const boxes = await this.prisma.mailbox.findMany({ where: { zoneId: z.id } });
        const aliases = await this.prisma.mailAlias.findMany({ where: { zoneId: z.id } });
        if ([...boxes, ...aliases].some((m) => m.local === local)) {
          throw new BadRequestException('That address is already in use.');
        }
        await this.prisma.mailbox.create({
          data: { zoneId: z.id, local, quota: Number(p.quota) || 100 },
        });
        await this.activity(wsId, 'Demo mailbox created', `${local}@${z.name}`, 'domain');
        break;
      }
      case 'deleteMailbox': {
        const m = await this.prisma.mailbox.findFirst({
          where: { id: String(p.mailboxId), zone: { workspaceId: wsId } },
        });
        if (!m) throw new BadRequestException('Mailbox not found.');
        const z = await findZone(m.zoneId);
        await this.prisma.mailbox.delete({ where: { id: m.id } });
        await this.prisma.mailAlias.deleteMany({ where: { zoneId: z.id, target: `${m.local}@${z.name}` } });
        await this.activity(wsId, 'Demo mailbox removed', `${m.local}@${z.name}`, 'domain');
        break;
      }
      case 'createAlias': {
        const z = await findZone(p.zoneId);
        const local = String(p.local ?? '').toLowerCase().trim();
        if (!/^[a-z0-9][a-z0-9._+-]{0,62}$/.test(local)) {
          throw new BadRequestException('Enter a valid alias name.');
        }
        const boxes = await this.prisma.mailbox.findMany({ where: { zoneId: z.id } });
        const aliases = await this.prisma.mailAlias.findMany({ where: { zoneId: z.id } });
        if ([...boxes, ...aliases].some((m) => m.local === local)) {
          throw new BadRequestException('That address is already in use.');
        }
        const target = String(p.target ?? '');
        if (!boxes.some((m) => `${m.local}@${z.name}` === target)) {
          throw new BadRequestException('Choose a valid destination mailbox.');
        }
        await this.prisma.mailAlias.create({ data: { zoneId: z.id, local, target } });
        await this.activity(wsId, 'Demo alias created', `${local}@${z.name} → ${target}`, 'domain');
        break;
      }
      case 'deleteAlias': {
        const a = await this.prisma.mailAlias.findFirst({
          where: { id: String(p.aliasId), zone: { workspaceId: wsId } },
        });
        if (!a) throw new BadRequestException('Alias not found.');
        await this.prisma.mailAlias.delete({ where: { id: a.id } });
        await this.activity(wsId, 'Demo alias removed', a.local, 'domain');
        break;
      }
      case 'bucketCreate': {
        const s = await findService(p.storageId);
        const name = String(p.name ?? '').trim();
        if (!/^[a-z][a-z0-9-]{2,51}$/.test(name)) {
          throw new BadRequestException('Choose a valid bucket name.');
        }
        const existing = await this.prisma.bucket.findMany({ where: { workspaceId: wsId } });
        if (existing.some((b) => b.name === name)) {
          throw new BadRequestException('Bucket name already exists in this workspace.');
        }
        const b = await this.prisma.bucket.create({
          data: {
            workspaceId: wsId, storageServiceId: s.id, name, privacy: 'private',
            purpose: String(p.purpose ?? 'Managed media').slice(0, 90),
            maxMB: Number(p.maxMB) || 500,
          },
        });
        await this.activity(wsId, 'Private bucket created (demo)', name, 'system');
        void b;
        break;
      }
      case 'storageFolderCreate': {
        const b = await this.prisma.bucket.findFirst({
          where: { id: String(p.bucketId), workspaceId: wsId },
        });
        if (!b) throw new BadRequestException('Bucket not found.');
        const name = String(p.name ?? '').trim();
        if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name)) throw new BadRequestException('Invalid folder name.');
        const key = `${String(p.prefix ?? '')}${name}/`;
        const dup = await this.prisma.storageObject.findFirst({
          where: { bucketId: b.id, key },
        });
        if (dup) throw new BadRequestException('Folder already exists.');
        await this.prisma.storageObject.create({
          data: { workspaceId: wsId, bucketId: b.id, key, size: 0, type: 'application/x-folder', isFolder: true },
        });
        await this.activity(wsId, 'Virtual prefix created (demo)', `${b.name}/${key}`, 'system');
        break;
      }
      case 'objectUpload': {
        const b = await this.prisma.bucket.findFirst({
          where: { id: String(p.bucketId), workspaceId: wsId },
        });
        if (!b) throw new BadRequestException('Bucket not found.');
        const key = String(p.key ?? '');
        if (!key || key.includes('..')) throw new BadRequestException('Invalid object key.');
        const dup = await this.prisma.storageObject.findFirst({ where: { bucketId: b.id, key } });
        if (dup) throw new BadRequestException('An object with that name already exists in this bucket.');
        await this.prisma.storageObject.create({
          data: {
            workspaceId: wsId, bucketId: b.id, key,
            size: Math.max(0, Number(p.size) || 0), type: String(p.type ?? 'application/octet-stream'),
          },
        });
        await this.activity(wsId, 'Upload metadata recorded (demo)', `${b.name}/${key}`, 'system');
        break;
      }
      case 'objectDelete': {
        const o = await this.prisma.storageObject.findFirst({
          where: { id: String(p.objectId), workspaceId: wsId },
        });
        if (!o) throw new BadRequestException('Object not found.');
        await this.prisma.storageObject.delete({ where: { id: o.id } });
        await this.activity(wsId, 'Object metadata removed (demo)', o.key, 'system');
        break;
      }
      case 'storageGrant': {
        const s = await findService(p.storageId);
        const b = await this.prisma.bucket.findFirst({
          where: { id: String(p.bucketId), workspaceId: wsId },
        });
        const a = await findService(p.serviceId);
        const scope = String(p.scope);
        if (!b || a.kind !== 'application' || a.projectId !== s.projectId ||
          b.storageServiceId !== s.id || !['read', 'upload', 'read-write'].includes(scope)) {
          throw new BadRequestException('Invalid bucket permission.');
        }
        const grants = await this.prisma.storageGrant.findMany({ where: { workspaceId: wsId } });
        if (grants.some((g) => g.storageServiceId === s.id && g.bucketId === b.id && g.serviceId === a.id)) {
          throw new BadRequestException('This connection already exists. Revoke it before replacing.');
        }
        await this.prisma.storageGrant.create({
          data: { workspaceId: wsId, storageServiceId: s.id, bucketId: b.id, serviceId: a.id, scope },
        });
        await this.activity(wsId, 'Bucket access granted (demo)', `${a.name} → ${b.name} (${scope})`, 'system');
        break;
      }
      case 'storageRevokeGrant': {
        const g = await this.prisma.storageGrant.findFirst({
          where: { id: String(p.grantId), workspaceId: wsId },
        });
        if (!g) throw new BadRequestException('Grant not found.');
        await this.prisma.storageGrant.delete({ where: { id: g.id } });
        await this.activity(wsId, 'Storage access revoked (demo)', g.id, 'system');
        break;
      }
      case 'volumeCreate': {
        const a = await findService(p.serviceId);
        const name = String(p.name ?? '').trim();
        const mount = String(p.mount ?? '');
        const quotaMB = Number(p.quotaMB);
        if (a.kind !== 'application' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) ||
          !['/data', '/uploads', '/cache'].includes(mount) ||
          ![100, 250, 500].includes(quotaMB)) {
          throw new BadRequestException('Invalid volume request.');
        }
        const vols = await this.prisma.persistentVolume.findMany({ where: { serviceId: a.id } });
        if (vols.some((v) => v.name === name || v.mountPath === mount)) {
          throw new BadRequestException('Volume name or mount point already exists.');
        }
        await this.prisma.persistentVolume.create({
          data: { serviceId: a.id, name, mountPath: mount, quotaMB },
        });
        await this.activity(wsId, 'Volume allocated (demo)', `${a.name} → ${mount}`, 'system');
        break;
      }
      case 'apiKeyCreate': {
        const name = String(p.name ?? '').trim();
        if (!name) throw new BadRequestException('Enter a key name.');
        const scope = String(p.scope ?? 'projects:read');
        const value = 'cl_demo_' + Math.random().toString(36).slice(2, 14) + '_' +
          Math.random().toString(36).slice(2, 14);
        await this.prisma.apiKey.create({
          data: {
            userId, name, keyHash: `demo:${value}`, last4: value.slice(-4), scopes: [scope],
          },
        });
        await this.activity(wsId, 'Demo API key created', name, 'system');
        return { generatedKey: value, ...(await this.getAggregate(userId)) };
      }
      case 'apiKeyRevoke': {
        const k = await this.prisma.apiKey.findFirst({ where: { id: String(p.id), userId } });
        if (!k || k.revokedAt) throw new BadRequestException('Key not found.');
        await this.prisma.apiKey.update({
          where: { id: k.id }, data: { revokedAt: now() },
        });
        await this.activity(wsId, 'Demo API key revoked', k.name, 'system');
        break;
      }
      case 'createGithubApp': {
        const repo = String(p.repo ?? '').trim();
        if (!ws.githubConnected) throw new BadRequestException('Connect the GitHub demo account first.');
        if (!repo) throw new BadRequestException('Enter a repository like owner/project.');
        const projectId = await this.resolveProject(wsId, p);
        const name = String(p.name ?? '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) {
          throw new BadRequestException('Use a valid application service name.');
        }
        const frameworkRaw = String(p.framework ?? 'auto');
        const framework = frameworkRaw === 'auto' ? 'Node.js/Express' : frameworkRaw;
        const role = framework === 'NestJS' || (framework === 'Node.js/Express' && /api|backend|server/i.test(name + repo)) ? 'api' : 'web';
        let realGithub: { serviceId: string } | null = null;
        try {
          const r = await this.apps.createGithubAppReal(userId, {
            projectId,
            name, repoFullName: repo, branch: String(p.branch ?? 'main'),
            autoDeploy: !!p.autoDeploy, framework,
          });
          if (r.mode === 'real') realGithub = { serviceId: r.serviceId };
        } catch (err) {
          if (!(err instanceof BadRequestException) || !(err.message as string).includes('GitHub App')) throw err;
        }
        if (realGithub) {
          await this.activity(wsId, 'Deployment requested', `${name} · GitHub (real pipeline)`, 'deploy');
          break;
        }
        const s = await S.create({
          data: {
            projectId, environmentId: await this.envFor(projectId), name,
            kind: 'application', role, source: 'github', framework,
            repoFullName: repo, branch: String(p.branch ?? 'main'),
            autoDeploy: !!p.autoDeploy, observedState: 'deploying',
          },
        });
        const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const allDomains = await this.prisma.domain.findMany({ where: { workspaceId: wsId } });
        const count = allDomains.filter((d) => d.host.startsWith(`${slug}.`)).length;
        await this.prisma.domain.create({
          data: {
            workspaceId: wsId,
            host: `${slug}${count ? '-' + s.id.slice(-3) : ''}.${this.appSuffix}`,
            status: 'VERIFIED', dnsMode: 'MANUAL', verificationToken: uid('verify'),
          },
        });
        await this.prisma.deployment.create({
          data: {
            serviceId: s.id, status: 'QUEUED', stage: 0,
            revision: Math.random().toString(16).slice(2, 9),
          },
        });
        await this.activity(wsId, 'Deployment requested', `${name} · GitHub`, 'deploy');
        break;
      }
      case 'simulateDeployment': {
        const s = await findService(p.serviceId);
        const open = await this.prisma.deployment.findFirst({
          where: { serviceId: s.id, status: { notIn: ['LIVE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ROLLED_BACK'] } },
        });
        if (open) throw new BadRequestException('A deployment is already running for this service.');
        const total = await this.prisma.deployment.count({ where: { serviceId: s.id } });
        const d = await this.prisma.deployment.create({
          data: {
            serviceId: s.id, status: 'QUEUED', stage: 0,
            revision: s.source === 'github' ? Math.random().toString(16).slice(2, 9)
              : `zip-${String(total + 1).padStart(3, '0')}`,
          },
        });
        if (!s.activeDeploymentId) {
          await S.update({ where: { id: s.id }, data: { observedState: 'deploying' } });
        }
        await this.activity(wsId, 'Deployment requested', `${s.name} · ${s.source === 'github' ? 'GitHub' : 'ZIP'}`, 'deploy');
        void d;
        break;
      }
      case 'finalizeDeployment': {
        const d = await this.prisma.deployment.findFirst({
          where: { id: String(p.deploymentId), service: { project: { workspaceId: wsId } } },
        });
        if (!d) throw new BadRequestException('Deployment not found.');
        const failed = !!p.failed;
        const logs = Array.isArray(p.logs)
          ? (p.logs as { msg: string; level: string }[]).slice(-50)
          : [];
        await this.prisma.$transaction(async (tx) => {
          await tx.deploymentEvent.deleteMany({ where: { deploymentId: d.id } });
          for (const l of logs) {
            await tx.deploymentEvent.create({
              data: {
                deploymentId: d.id, message: String(l.msg), level: (l.level as never),
                stage: (failed ? 'FAILED' : 'LIVE') as never,
              },
            });
          }
          await tx.deployment.update({
            where: { id: d.id },
            data: {
              status: failed ? 'FAILED' : 'LIVE', stage: 8,
              finishedAt: new Date(),
              errorMessage: failed ? 'Simulated failure. Candidate not activated.' : null,
            },
          });
          const svc = await tx.service.findUnique({ where: { id: d.serviceId } });
          if (svc) {
            if (failed) {
              if (!svc.activeDeploymentId) await tx.service.update({ where: { id: svc.id }, data: { observedState: 'failed' } });
            } else {
              await tx.service.update({
                where: { id: svc.id }, data: { activeDeploymentId: d.id, observedState: 'running' },
              });
            }
          }
        });
        const svc = await findService(d.serviceId);
        await this.activity(wsId, failed ? 'Deployment failed' : 'Deployment is live',
          failed ? `${svc.name} · existing healthy release retained` : `${svc.name} · release ${d.revision}`, 'deploy');
        break;
      }
      case 'rollbackDeployment': {
        const d = await this.prisma.deployment.findFirst({
          where: { id: String(p.deploymentId), service: { project: { workspaceId: wsId } } },
        });
        if (!d || d.status !== 'LIVE') throw new BadRequestException('Only a live release can be restored.');
        const svc = await findService(d.serviceId);
        let summary = `${svc.name} · ${d.revision}`;
        try {
          const r = await this.apps.rollbackReal(userId, d.serviceId, d.id);
          if (r.mode === 'real') summary = r.summary;
        } catch { /* demo release — pointer flip below */ }
        await S.update({
          where: { id: svc.id },
          data: { activeDeploymentId: d.id, observedState: 'running' },
        });
        await this.activity(wsId, 'Release rolled back', summary, 'deploy');
        break;
      }
      case 'confirmPlatformDns': {
        const d = await this.prisma.domain.findFirst({
          where: { id: String(p.domainId), workspaceId: wsId },
        });
        if (!d) throw new BadRequestException('Domain not found.');
        await this.prisma.domain.update({
          where: { id: d.id }, data: { status: 'VERIFIED' },
        });
        await this.activity(wsId, 'HTTPS enabled', d.host, 'domain');
        break;
      }
      case 'assistantApproved': {
        await this.activity(wsId, 'Assistant plan approved (simulation)',
          String(p.summary ?? ''), 'system');
        break;
      }
      case 'simulatePushServiceLink': {
        const a = await findService(p.from);
        const b = await findService(p.to);
        if (a.projectId !== b.projectId || a.kind !== 'application' || b.kind !== 'database') {
          throw new BadRequestException('Choose a valid application and database in the same project.');
        }
        const links = await this.prisma.serviceLink.findMany({ where: { workspaceId: wsId } });
        if (links.some((l) => l.fromServiceId === a.id && l.toServiceId === b.id)) break;
        await this.prisma.serviceLink.create({
          data: { workspaceId: wsId, fromServiceId: a.id, toServiceId: b.id },
        });
        await this.activity(wsId, 'Connection recorded (demo)', `${a.name} → ${b.name}`, 'system');
        break;
      }
      case 'removeServiceLink': {
        await this.prisma.serviceLink.deleteMany({
          where: { id: String(p.id), workspaceId: wsId },
        });
        await this.activity(wsId, 'Demo connection removed', String(p.id), 'system');
        break;
      }
      default:
        throw new BadRequestException(`Unknown action: ${type}`);
    }
    return this.getAggregate(userId);
  }

  private async envFor(projectId: string): Promise<string> {
    const env = await this.prisma.environment.upsert({
      where: { projectId_name: { projectId, name: 'production' } },
      create: { projectId, name: 'production' },
      update: {},
    });
    return env.id;
  }
}
