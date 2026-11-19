/**
 * AppPipelineService — upgrades the panel's simulated workspace actions to the
 * REAL deployment pipeline where possible, without touching the real ZIP flow
 * (uploads → services.createFromZip → deployments.service → agent → Caddy).
 *
 * What the real pipeline already does (verified against the live agent shim
 * /usr/local/bin/cloudlane-agent.js and deployments.service.ts):
 *  - BUILD:   API extracts the ZIP/tar.gz artifact to
 *             /var/lib/cloudlane/deployments/{deploymentId}/html (pure Node).
 *  - START:   agent `release.startCandidate` → docker run
 *             cloudlane-svc-{deploymentId} on the cloudlane-internal network,
 *             publishing 127.0.0.1:{allocPort 4101-4999} → 80 (caddy
 *             file-server over the mounted artifact).
 *  - HEALTH:  API probes http://127.0.0.1:{port}/ (30s budget).
 *  - ACTIVATE: agent `release.activate` → stops/removes the previous active
 *             container (atomic swap), writes /etc/caddy/services/{serviceId}.caddy
 *             (handle /services/{serviceId}/* + reverse_proxy 127.0.0.1:{port}),
 *             validates + reloads /etc/caddy/Caddyfile (which imports
 *             /etc/caddy/services/*.caddy inside the panel site block).
 *  - LIVE:    deployment LIVE + service.activeDeploymentId updated.
 *
 * This service reuses those exact agent operations for the panel actions:
 *   rollbackReal          — re-activates a previous LIVE release artifact
 *                           (startCandidate → probe → activate), falling back
 *                           to the old DB-pointer flip for simulated releases.
 *   platformRoute         — idempotent ensure of the deployer-written platform
 *                           route (documented: the deployer already creates it
 *                           at ACTIVATING; this repairs drifted/lost routes).
 *   variablesRevision     — real redeploy after addVar/removeVar for services
 *                           with a real ZIP source; demo otherwise.
 *   createGithubAppReal   — real GitHub-sourced service + deployment when the
 *                           GitHub App is configured; {mode:'demo'} otherwise.
 *   stopStart             — real docker stop / (re)start via agent ops.
 *
 * Every result is discriminated by `mode: 'real' | 'demo'` so the caller
 * (workspace.service actions) can log the right activity item and the
 * integrator can keep simulations where the real path is unavailable.
 */
import { createSign } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';
import { AgentService } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DeploymentsService } from '../deployments/deployments.service.js';
import { ServicesService } from '../services/services.service.js';

/** Deployment artifacts written by the real pipeline (deployments.service). */
const DEPLOYMENTS_DIR = '/var/lib/cloudlane/deployments';
/** Per-service Caddy route snippets written by the agent at activate. */
const CADDY_SERVICES_DIR = '/etc/caddy/services';

const FINAL_DEPLOYMENT_STATUSES = ['LIVE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ROLLED_BACK'] as const;

/** Container name convention used by the agent for a deployment candidate. */
const containerNameFor = (deploymentId: string) => `cloudlane-svc-${deploymentId}`;

export type PipelineMode = 'real' | 'demo';

export interface RollbackResult {
  mode: PipelineMode;
  serviceId: string;
  deploymentId: string;
  /** Ready-made activity-feed summary: "<service> · <revision>". */
  summary: string;
  url?: string;
  port?: number;
  reason?: string;
}

export interface PlatformRouteResult {
  mode: PipelineMode;
  serviceId: string;
  ensured: boolean;
  /** True when the deployer already wired the route and it is current. */
  alreadyWired?: boolean;
  /** True when a drifted/missing route was re-activated through the agent. */
  repaired?: boolean;
  url?: string;
  port?: number;
  reason?: string;
}

export interface VariablesRevisionResult {
  mode: PipelineMode;
  serviceId: string;
  deploymentId?: string;
  reason?: string;
}

export interface CreateGithubAppRealInput {
  projectId: string;
  name: string;
  repoFullName: string;
  branch: string;
  autoDeploy: boolean;
  /** Panel framework selector; 'auto' resolves to 'Node.js/Express'. */
  framework?: string;
}

export interface CreateGithubAppRealResult {
  mode: PipelineMode;
  serviceId?: string;
  deploymentId?: string;
  repoFullName?: string;
  branch?: string;
  summary?: string;
  reason?: string;
}

export interface StopStartResult {
  mode: PipelineMode;
  serviceId: string;
  desired: 'running' | 'stopped';
  state?: 'running' | 'stopped';
  alreadyRunning?: boolean;
  reason?: string;
}

interface AgentInspectResult {
  state?: string;
  healthStatus?: string;
}

@Injectable()
export class AppPipelineService {
  private readonly logger = new Logger(AppPipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agent: AgentService,
    private readonly deployments: DeploymentsService,
    private readonly services: ServicesService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // 1. Rollback — re-activate a previous LIVE release through the real deployer
  // ---------------------------------------------------------------------------

  /**
   * Roll the service back to a previous LIVE deployment.
   *
   * Real path (release has a build artifact on disk): mirrors the deployer's
   * activation sequence from deployments.service.processDeployment —
   * release.startCandidate on the OLD artifact → health probe →
   * release.activate (agent stops the currently-active container, atomically
   * rewrites /etc/caddy/services/{serviceId}.caddy and reloads Caddy) — then
   * points service.activeDeploymentId at the target. The target deployment
   * stays LIVE and gets ACTIVATING/LIVE events appended so the UI timeline
   * shows the rollback.
   *
   * Demo path (simulated release, no artifact — e.g. the seeded panel
   * services): preserves the old panel behaviour exactly (DB pointer flip +
   * observedState running) so the rollback button keeps working for demos.
   *
   * Mirrors the guards of POST /services/:serviceId/rollbacks
   * (deployments.service.rollback): ownership, deployment-belongs-to-service,
   * target must be LIVE.
   */
  async rollbackReal(userId: string, serviceId: string, deploymentId: string): Promise<RollbackResult> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        service: { include: { project: { include: { workspace: true } }, zipSource: true } },
      },
    });
    if (
      !deployment ||
      deployment.serviceId !== serviceId ||
      deployment.service.project.workspace.ownerId !== userId
    ) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Deployment not found for this service.' });
    }
    if (deployment.status !== 'LIVE') {
      throw new BadRequestException('Only a live release can be restored.');
    }

    const service = deployment.service;
    const summary = `${service.name} · ${deployment.revision}`;

    if (!(await this.hasRealArtifact(deploymentId))) {
      // Simulated release — keep the existing panel behaviour (pointer flip).
      await this.prisma.service.update({
        where: { id: serviceId },
        data: { activeDeploymentId: deploymentId, observedState: 'running', observedAt: new Date() },
      });
      await this.audit.record('DEPLOYMENT_ROLLED_BACK', 'success', {
        actorType: 'user',
        actorUserId: userId,
        workspaceId: service.project.workspaceId,
        resourceType: 'deployment',
        resourceId: deploymentId,
        metadata: { serviceId, simulated: true },
      });
      return {
        mode: 'demo',
        serviceId,
        deploymentId,
        summary,
        reason: 'Simulated release (no build artifact on disk); active-release pointer updated only.',
      };
    }

    await this.assertNoOpenDeployment(serviceId);
    const workspaceId = service.project.workspaceId;
    const htmlDir = this.artifactDir(deploymentId);

    const port = await this.startCandidateAndProbe(workspaceId, serviceId, deploymentId, htmlDir);
    await this.activateRoute(workspaceId, serviceId, deploymentId, port);

    await this.prisma.service.update({
      where: { id: serviceId },
      data: {
        activeDeploymentId: deploymentId,
        desiredState: 'running',
        observedState: 'running',
        observedAt: new Date(),
      },
    });
    await this.prisma.deploymentEvent.createMany({
      data: [
        {
          deploymentId,
          stage: 'ACTIVATING',
          level: 'info',
          message: `[ROLLBACK] Re-activating release ${deployment.revision} from stored artifact`,
        },
        {
          deploymentId,
          stage: 'LIVE',
          level: 'success',
          message: `[READY] Release ${deployment.revision} re-activated on 127.0.0.1:${port}`,
        },
      ],
    });
    await this.audit.record('DEPLOYMENT_ROLLED_BACK', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'deployment',
      resourceId: deploymentId,
      metadata: { serviceId, port },
    });
    this.logger.log(`Rollback: service ${serviceId} re-activated deployment ${deploymentId} on :${port}`);

    return { mode: 'real', serviceId, deploymentId, summary, url: `/services/${serviceId}/`, port };
  }

  // ---------------------------------------------------------------------------
  // 2. Platform route — idempotent ensure of the deployer's Caddy route
  // ---------------------------------------------------------------------------

  /**
   * Ensure the platform route for a service exists and points at its live
   * release.
   *
   * VERIFIED (live VPS): the deployer ALREADY creates the real platform route
   * at the ACTIVATING stage — the agent writes
   * /etc/caddy/services/{serviceId}.caddy with
   *   handle /services/{serviceId}/* { uri strip_prefix …; reverse_proxy 127.0.0.1:{port} }
   * and validates+reloads /etc/caddy/Caddyfile (which imports
   * /etc/caddy/services/*.caddy inside the panel site block). So this method
   * does NOT duplicate that: it reuses the same `release.activate` helper as a
   * thin, idempotent repair — if the route file is current and the container
   * is running it is a no-op; if the route drifted (agent state lost, Caddy
   * re-provisioned, container gone) it re-runs startCandidate + activate.
   *
   * Note on hostnames: the `*.apps.example.test` rows the panel stores are
   * metadata only. The current Caddyfile layout has no host-based (site-block)
   * routing — the import sits INSIDE the `https://…` site block, where only
   * path-level directives (`handle`) are valid. Serving
   * `<slug>.apps.example.test` for real would need a top-level Caddyfile
   * import change on the host (deliberately not done here to avoid breaking
   * live config). Today the working public URL of every service is
   * https://<panel-host>/services/{serviceId}/.
   */
  async platformRoute(serviceName: string, serviceId: string, workspaceId: string): Promise<PlatformRouteResult> {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, name: serviceName, project: { workspaceId } },
      include: { zipSource: true },
    });
    if (!service) throw new BadRequestException('Service not found.');
    if (service.kind !== 'application') {
      return { mode: 'demo', serviceId, ensured: false, reason: 'Only application services get routes.' };
    }

    const active = await this.activeLiveDeployment(serviceId);
    if (!active) {
      return {
        mode: service.zipSource ? 'real' : 'demo',
        serviceId,
        ensured: false,
        reason: service.zipSource
          ? 'No LIVE release yet; the deployer writes the route at the ACTIVATING stage.'
          : 'Panel-only service (no real ZIP source); the route appears after the first real deploy.',
      };
    }

    try {
      // Already wired? Route file matches the active deployment AND the
      // candidate container is actually running.
      const [snippet, inspect] = await Promise.all([
        this.readRouteSnippet(serviceId),
        this.inspectContainer(workspaceId, active.id),
      ]);
      const routeCurrent = snippet?.includes(`deployment ${active.id}`) ?? false;
      if (routeCurrent && inspect.state === 'running') {
        return { mode: 'real', serviceId, ensured: true, alreadyWired: true, url: `/services/${serviceId}/` };
      }

      // Repair: recreate the candidate for the active release (idempotent —
      // the agent removes the old container) and re-activate its route.
      const port = await this.startCandidateAndProbe(
        workspaceId,
        serviceId,
        active.id,
        this.artifactDir(active.id),
      );
      await this.activateRoute(workspaceId, serviceId, active.id, port);
      this.logger.log(`platformRoute: repaired route for service ${serviceId} (deployment ${active.id}) on :${port}`);
      return { mode: 'real', serviceId, ensured: true, repaired: true, url: `/services/${serviceId}/`, port };
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(`platformRoute: could not ensure route for ${serviceId}: ${reason}`);
      return { mode: 'real', serviceId, ensured: false, reason };
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Variables revision — redeploy through the real pipeline after var change
  // ---------------------------------------------------------------------------

  /**
   * Apply an environment-variable change (addVar/removeVar) by triggering a
   * real redeploy, so the change goes through the same stage machine as a
   * deploy and the UI shows live transitions (the panel polls GET /workspace
   * while a deployment is non-final).
   *
   * Real path ONLY when the service has a real ZIP source
   * (service.source === 'zip' && zipSource row): reuses
   * DeploymentsService.redeploy() internals (fresh REQUESTED deployment →
   * queueDeployment → full pipeline). Demo/GitHub panel services get
   * {mode:'demo'} — their source link is panel metadata and the real GitHub
   * fetch path is not wired on this VPS, so a fake pipeline run would fail at
   * FETCHING.
   *
   * Documented limitation: the current runtime serves static artifacts with
   * envVarsHash 'none' — variables are stored + audited in the DB and the
   * redeploy re-runs the real pipeline, but injecting them into container
   * env requires the framework build pipeline (§11.2 Phase 3).
   */
  async variablesRevision(userId: string, serviceId: string): Promise<VariablesRevisionResult> {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, project: { workspace: { ownerId: userId } } },
      include: { project: { include: { workspace: true } }, zipSource: true, githubLink: true },
    });
    if (!service) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });

    if (service.source === 'zip' && service.zipSource) {
      // Real pipeline: DeploymentsService.redeploy validates ownership again,
      // creates the deployment, flips the service to 'deploying' and queues
      // the full stage machine. It records DEPLOYMENT_STARTED itself.
      const { deploymentId } = await this.deployments.redeploy(userId, serviceId);
      this.logger.log(`variablesRevision: service ${serviceId} redeployed as ${deploymentId}`);
      return { mode: 'real', serviceId, deploymentId };
    }

    return {
      mode: 'demo',
      serviceId,
      reason:
        'Not a real ZIP build (GitHub/panel demo source); variables are stored and take effect on the next real deploy.',
    };
  }

  // ---------------------------------------------------------------------------
  // 4. GitHub App — real clone-source path when the App is configured
  // ---------------------------------------------------------------------------

  /**
   * Create a GitHub-sourced service and start a REAL deployment.
   *
   * Decision gate (per spec): the GitHub App must be configured on this VPS —
   * checked via GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY(_PATH) env. On the
   * current VPS none of these exist (verified: `grep -i github
   * /etc/cloudlane/api.env` is empty), so this returns {mode:'demo'} and the
   * integrator keeps the panel simulation for GitHub services.
   *
   * Real path (when credentials appear): preflight-resolves the branch head
   * via the GitHub REST API — anonymous first (public repos), then with a
   * signed GitHub App JWT + installation token — and only creates the service
   * when the archive is actually reachable. The service is created through
   * ServicesService.createFromGithub (same rows: Service + GithubInstallation
   * + REQUESTED deployment), which queues the real pipeline; the deployer's
   * fetchGithubArchive downloads the codeload tar.gz into the deployer's
   * expected layout (extracted artifact per deployment).
   */
  async createGithubAppReal(
    userId: string,
    input: CreateGithubAppRealInput,
  ): Promise<CreateGithubAppRealResult> {
    if (!this.githubAppConfigured()) {
      return {
        mode: 'demo',
        repoFullName: input.repoFullName,
        branch: input.branch,
        reason:
          'GitHub App not configured on this VPS (no GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY in /etc/cloudlane/api.env); keep the panel simulation for GitHub services.',
      };
    }

    const head = await this.resolveGithubHead(input.repoFullName, input.branch);
    if (!head) {
      throw new BadRequestException(
        `Cannot resolve ${input.repoFullName}@${input.branch} via the GitHub API.`,
      );
    }
    if (head.authenticated) {
      // Authenticated resolution means the repo is private: the deployer's
      // inline fetch (fetchGithubArchive) is public-only in Phase 1+2, so a
      // deployment created now would fail at FETCHING. Fail fast, keep demo.
      return {
        mode: 'demo',
        repoFullName: input.repoFullName,
        branch: input.branch,
        reason:
          'Private repository: the on-host pipeline fetches public archives only (Phase 1+2); private repos need the off-host build pipeline (§11.2 Phase 3).',
      };
    }

    // Same role inference as the panel demo (framework selector + name/repo heuristics).
    const framework = input.framework && input.framework !== 'auto' ? input.framework : 'Node.js/Express';
    const role =
      framework === 'NestJS' ||
      (framework === 'Node.js/Express' && /api|backend|server/i.test(input.name + input.repoFullName))
        ? 'api'
        : 'web';
    const installationId = Number(this.config.get<string>('GITHUB_APP_INSTALLATION_ID', '')) || 0;

    // Real creation path: Service + GithubInstallation + REQUESTED deployment,
    // then queueDeployment — identical to services.service.createFromGithub.
    const { serviceId, deploymentId } = await this.services.createFromGithub(
      userId,
      input.projectId,
      input.name,
      role,
      installationId,
      input.repoFullName,
      input.branch,
      input.autoDeploy,
    );
    this.logger.log(
      `createGithubAppReal: ${input.repoFullName}@${input.branch} → service ${serviceId}, deployment ${deploymentId}`,
    );
    return {
      mode: 'real',
      serviceId,
      deploymentId,
      repoFullName: input.repoFullName,
      branch: input.branch,
      summary: `${input.name} · GitHub (${input.repoFullName}@${input.branch})`,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. Stop / start — real container lifecycle via the agent command path
  // ---------------------------------------------------------------------------

  /**
   * Stop or start an application service through the same signed agent
   * command path the deployer uses (never a direct docker shell-out).
   *
   * 'stopped' → agent `release.stop` (docker stop -t 10 + rm -f of
   * cloudlane-svc-{deploymentId}); observedState → 'stopped'.
   *
   * 'running' → agent `release.inspect`; if the candidate is already running
   * this is a no-op. Otherwise the deployer's restart sequence is re-run on
   * the stored artifact: release.startCandidate → health probe →
   * release.activate (fixes the Caddy route even if the port changed);
   * observedState → 'running'.
   *
   * Services without a real release artifact (panel/seed demos) return
   * {mode:'demo'} and leave state untouched — no container exists to stop.
   */
  async stopStart(userId: string, serviceId: string, desired: 'running' | 'stopped'): Promise<StopStartResult> {
    const service = await this.ownedApplicationService(userId, serviceId);
    const active = service.activeDeploymentId
      ? await this.prisma.deployment.findFirst({
          where: { id: service.activeDeploymentId, serviceId, status: 'LIVE' },
        })
      : null;
    if (!active || !(await this.hasRealArtifact(active.id))) {
      return {
        mode: 'demo',
        serviceId,
        desired,
        reason: 'No real release artifact for this service; nothing to stop/start on the host.',
      };
    }

    await this.assertNoOpenDeployment(serviceId);
    const workspaceId = service.project.workspaceId;

    if (desired === 'stopped') {
      await this.agent.send('release.stop', workspaceId, active.id, {
        containerId: containerNameFor(active.id),
      });
      await this.prisma.service.update({
        where: { id: serviceId },
        data: { desiredState: 'stopped', observedState: 'stopped', observedAt: new Date() },
      });
      await this.audit.record('AGENT_COMMAND_SENT', 'success', {
        actorType: 'user',
        actorUserId: userId,
        workspaceId,
        resourceType: 'service',
        resourceId: serviceId,
        metadata: { operation: 'release.stop', deploymentId: active.id },
      });
      this.logger.log(`stopStart: service ${serviceId} stopped (deployment ${active.id})`);
      return { mode: 'real', serviceId, desired, state: 'stopped' };
    }

    const inspect = await this.inspectContainer(workspaceId, active.id);
    if (inspect.state === 'running') {
      return { mode: 'real', serviceId, desired, state: 'running', alreadyRunning: true };
    }

    const port = await this.startCandidateAndProbe(workspaceId, serviceId, active.id, this.artifactDir(active.id));
    await this.activateRoute(workspaceId, serviceId, active.id, port);
    await this.prisma.service.update({
      where: { id: serviceId },
      data: { desiredState: 'running', observedState: 'running', observedAt: new Date() },
    });
    await this.audit.record('AGENT_COMMAND_SENT', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId,
      resourceType: 'service',
      resourceId: serviceId,
      metadata: { operation: 'release.startCandidate', deploymentId: active.id, port },
    });
    this.logger.log(`stopStart: service ${serviceId} started (deployment ${active.id}) on :${port}`);
    return { mode: 'real', serviceId, desired, state: 'running' };
  }

  // ---------------------------------------------------------------------------
  // Shared internals — mirror deployments.service's agent sequences
  // ---------------------------------------------------------------------------

  private artifactDir(deploymentId: string): string {
    return join(DEPLOYMENTS_DIR, deploymentId, 'html');
  }

  /** True when the deployment has an extracted build artifact on disk. */
  private async hasRealArtifact(deploymentId: string): Promise<boolean> {
    try {
      const entries = await readdir(this.artifactDir(deploymentId));
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  private async activeLiveDeployment(serviceId: string) {
    return this.prisma.deployment.findFirst({
      where: { serviceId, status: 'LIVE' },
      orderBy: { startedAt: 'desc' },
    });
  }

  /** Reject concurrent pipeline runs (same guard as the panel's deploy actions). */
  private async assertNoOpenDeployment(serviceId: string): Promise<void> {
    const open = await this.prisma.deployment.findFirst({
      where: { serviceId, status: { notIn: [...FINAL_DEPLOYMENT_STATUSES] } },
    });
    if (open) throw new BadRequestException('A deployment is already running for this service.');
  }

  private async ownedApplicationService(userId: string, serviceId: string) {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, project: { workspace: { ownerId: userId } } },
      include: { project: { include: { workspace: true } }, zipSource: true },
    });
    if (!service) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    if (service.kind !== 'application') {
      throw new BadRequestException('Only application services support this operation.');
    }
    return service;
  }

  /**
   * release.startCandidate on a stored artifact + health probe — the exact
   * sequence deployments.service.processDeployment runs between
   * STARTING_CANDIDATE and HEALTH_CHECKING. Returns the published port.
   */
  private async startCandidateAndProbe(
    workspaceId: string,
    serviceId: string,
    deploymentId: string,
    htmlDir: string,
  ): Promise<number> {
    const resp = await this.agent.send('release.startCandidate', workspaceId, deploymentId, {
      imageRef: 'caddy:2-alpine',
      imageDigest: null,
      cpuLimit: 0.25,
      memoryLimitMiB: 64,
      internalPort: 80,
      envVarsHash: 'none',
      volumeIds: [],
      staticArtifactPath: htmlDir,
      serviceId,
    });
    const result = (resp.result ?? {}) as { port?: number };
    const port = Number(result.port ?? 0);
    if (!port || port <= 0) {
      throw new Error('Agent did not return a candidate port.');
    }
    await this.probeHealth(port);
    return port;
  }

  /** release.activate — same helper the deployer uses to wire the Caddy route. */
  private async activateRoute(
    workspaceId: string,
    serviceId: string,
    deploymentId: string,
    port: number,
  ): Promise<void> {
    await this.agent.send('release.activate', workspaceId, serviceId, {
      serviceId,
      deploymentId,
      port,
    });
  }

  private async inspectContainer(workspaceId: string, deploymentId: string): Promise<AgentInspectResult> {
    const resp = await this.agent.send('release.inspect', workspaceId, deploymentId, {
      containerName: containerNameFor(deploymentId),
    });
    return (resp.result ?? {}) as AgentInspectResult;
  }

  /** HTTP probe against the candidate's published localhost port (§11.3). */
  private async probeHealth(port: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = 'no attempt';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Health check failed after 30s: ${lastErr}`);
  }

  /** Read the agent-written route snippet (missing when never activated). */
  private async readRouteSnippet(serviceId: string): Promise<string | null> {
    try {
      return await readFile(join(CADDY_SERVICES_DIR, `${serviceId}.caddy`), 'utf8');
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // GitHub App configuration gate + authenticated archive preflight
  // ---------------------------------------------------------------------------

  private githubAppConfigured(): boolean {
    const appId = this.config.get<string>('GITHUB_APP_ID', '');
    const pemInline = this.config.get<string>('GITHUB_APP_PRIVATE_KEY', '');
    const pemPath = this.config.get<string>('GITHUB_APP_PRIVATE_KEY_PATH', '');
    return Boolean(appId && (pemInline || pemPath));
  }

  private async githubAppPrivateKey(): Promise<string | null> {
    const pemInline = this.config.get<string>('GITHUB_APP_PRIVATE_KEY', '');
    if (pemInline) return pemInline.replace(/\\n/g, '\n');
    const pemPath = this.config.get<string>('GITHUB_APP_PRIVATE_KEY_PATH', '');
    if (pemPath) {
      try {
        return await readFile(pemPath, 'utf8');
      } catch {
        return null;
      }
    }
    return null;
  }

  /** RS256 GitHub App JWT (node:crypto only — no extra dependency). */
  private githubAppJwt(appId: string, pem: string): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', typ: 'JWT' });
    const payload = b64({ iat: now - 30, exp: now + 300, iss: appId });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(pem).toString('base64url')}`;
  }

  /**
   * Authorization headers for the GitHub REST API: App JWT, upgraded to an
   * installation token when GITHUB_APP_INSTALLATION_ID is set.
   */
  private async githubAuthHeaders(): Promise<Record<string, string>> {
    const appId = this.config.get<string>('GITHUB_APP_ID', '');
    const pem = await this.githubAppPrivateKey();
    if (!appId || !pem) return {};
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.githubAppJwt(appId, pem)}`,
    };
    const installationId = Number(this.config.get<string>('GITHUB_APP_INSTALLATION_ID', ''));
    if (installationId > 0) {
      try {
        const res = await fetch(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.ok) {
          const body = (await res.json()) as { token?: string };
          if (body.token) headers.Authorization = `Bearer ${body.token}`;
        }
      } catch {
        // Fall back to the App JWT (works for app-level endpoints only).
      }
    }
    return headers;
  }

  /**
   * Resolve the branch head commit. Tries anonymous first (public repos);
   * falls back to GitHub App auth. Returns null when unreachable either way.
   * `authenticated: true` implies the repo is private.
   */
  private async resolveGithubHead(
    repoFullName: string,
    branch: string,
  ): Promise<{ sha: string; authenticated: boolean } | null> {
    const safeRepo = repoFullName.replace(/[^\w.\-/]/g, '');
    const safeBranch = encodeURIComponent(branch);
    const url = `https://api.github.com/repos/${safeRepo}/commits/${safeBranch}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { sha?: string };
        return { sha: body.sha ?? '', authenticated: false };
      }
    } catch {
      // Fall through to authenticated attempt.
    }

    const headers = await this.githubAuthHeaders();
    if (!headers.Authorization) return null;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { sha?: string };
      return { sha: body.sha ?? '', authenticated: true };
    } catch {
      return null;
    }
  }
}
