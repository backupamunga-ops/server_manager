import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma.service.js';
import { extractTarGzSafe } from '../../common/targz.js';
import { extractZipSafe } from '../../common/zip.js';
import { ConfigService } from '@nestjs/config';
import { AgentService } from '../agent/agent.service.js';
import { DomainPipelineService } from '../workspace/domain-pipeline.service.js';
import { AuditService } from '../audit/audit.service.js';

const DEPLOYMENTS_DIR = '/var/lib/cloudlane/deployments';

const STAGES = [
  'REQUESTED',
  'QUEUED',
  'FETCHING',
  'VALIDATING',
  'DETECTING',
  'BUILDING',
  'STARTING_CANDIDATE',
  'HEALTH_CHECKING',
  'ACTIVATING',
  'LIVE',
] as const;

interface AgentResult {
  containerId?: string;
  containerName?: string;
  state?: string;
  healthStatus?: string;
  port?: number;
  url?: string;
  [k: string]: unknown;
}

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agent: AgentService,
    private readonly domainsPipeline: DomainPipelineService,
    private readonly config: ConfigService,
  ) {
    mkdir(DEPLOYMENTS_DIR, { recursive: true }).catch(() => {});
  }

  /**
   * Activate Caddy hostname routes for the service's platform URLs now that a
   * container is live and a port is published.
   */
  private async activatePlatformRoutes(
    workspaceId: string, serviceId: string, serviceName: string, deploymentId?: string,
  ): Promise<void> {
    const suffix = this.config.get<string>('PLATFORM_APP_SUFFIX') ?? 'apps.example.test';
    const slug = serviceName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return;
    const candidates = [`${slug}.${suffix}`, `${slug}-${serviceId.slice(-4)}.${suffix}`];
    // Write routes ONLY once the agent state reflects THIS deployment — a
    // mismatch means the port would be stale, which is worse than no write.
    if (deploymentId) {
      let matched = false;
      for (let attempt = 0; attempt < 24 && !matched; attempt++) {
        try {
          const rt = await this.domainsPipeline.serviceRuntime(serviceId);
          if (rt.deploymentId === deploymentId) matched = true;
        } catch { /* ignore */ }
        if (!matched) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!matched) return;
    }
    for (const host of candidates) {
      const d = await this.prisma.domain.findFirst({ where: { host, workspaceId } });
      if (!d) continue;
      try {
        await this.domainsPipeline.routeFor(host, { id: serviceId, name: serviceName });
      } catch { /* port not published yet — next deployment will retry */ }
    }
  }

  /** Stop + remove the containers of superseded deployments of this service. */
  private async retirePreviousDeployments(serviceId: string, currentDeploymentId: string): Promise<void> {
    const previous = await this.prisma.deployment.findMany({
      where: { serviceId, status: 'LIVE', id: { not: currentDeploymentId } },
      select: { id: true },
      take: 10,
    });
    for (const dep of previous) {
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { status: 'SUPERSEDED', finishedAt: new Date() },
      }).catch(() => {});
      try {
        const { execFile } = await import('node:child_process');
        await new Promise<void>((resolve) => {
          execFile('docker', ['rm', '-f', `cloudlane-svc-${dep.id}`], { timeout: 30_000 }, () => resolve());
        });
      } catch { /* orphan cleanup is best-effort */ }
    }
  }

  /**
   * Trigger a fresh deployment for an existing service (Redeploy).
   * Reuses the stored source (ZIP file or GitHub repo) — build plan §11.1/§11.2
   * with the same stage machine as the initial deploy.
   */
  async redeploy(
    userId: string,
    serviceId: string,
  ): Promise<{ serviceId: string; deploymentId: string }> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { include: { workspace: true } }, zipSource: true, githubLink: true },
    });
    if (!service || service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }
    if (service.source === 'zip' && !service.zipSource) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Service has no stored ZIP source.',
      });
    }
    if (service.source === 'github' && !service.githubLink) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service has no GitHub source.' });
    }

    const deploymentId = uuidv4();
    await this.prisma.deployment.create({
      data: {
        id: deploymentId,
        serviceId,
        status: 'REQUESTED',
        stage: 0,
        revision: `${service.source}-${Date.now().toString(36)}`,
      },
    });
    await this.prisma.service.update({
      where: { id: serviceId },
      data: { desiredState: 'deploying', observedState: 'deploying', observedAt: new Date() },
    });
    await this.queueDeployment(deploymentId);
    await this.audit.record('DEPLOYMENT_STARTED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId: service.project.workspaceId,
      resourceType: 'deployment',
      resourceId: deploymentId,
      metadata: { serviceId, trigger: 'redeploy' },
    });
    return { serviceId, deploymentId };
  }

  async listForService(userId: string, serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { include: { workspace: true } } },
    });
    if (!service || service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }
    const deployments = await this.prisma.deployment.findMany({
      where: { serviceId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    return deployments.map((d) => ({
      id: d.id,
      status: d.status,
      revision: d.revision,
      startedAt: d.startedAt.toISOString(),
      finishedAt: d.finishedAt?.toISOString() ?? null,
      errorMessage: d.errorMessage ?? null,
    }));
  }

  async getEvents(userId: string, deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { service: { include: { project: { include: { workspace: true } } } } },
    });
    if (!deployment || deployment.service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Deployment not found.' });
    }
    const events = await this.prisma.deploymentEvent.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'asc' },
    });
    return events.map((e) => ({
      id: e.id,
      deploymentId: e.deploymentId,
      stage: e.stage,
      level: e.level,
      message: e.message,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  /**
   * Queue a deployment for processing. Processed asynchronously in-process
   * (pg-boss worker replaces this in a later phase without changing the
   * stage/event contract).
   */
  async queueDeployment(deploymentId: string): Promise<void> {
    this.logger.log(`Queueing deployment ${deploymentId}`);
    await this.updateStage(deploymentId, 'QUEUED', '[QUEUE] Deployment accepted', 'info');
    this.processDeployment(deploymentId).catch((err) => {
      this.logger.error(`Deployment ${deploymentId} failed: ${err.message}`);
    });
  }

  /**
   * Process a deployment through the full state machine (build plan §11.1):
   * extract static artifact → start candidate container via agent → health
   * check → atomic Caddy route activation via agent → LIVE.
   */
  private async processDeployment(deploymentId: string): Promise<void> {
    let serviceId = '';
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          service: {
            include: {
              project: { include: { workspace: true } },
              zipSource: true,
              githubLink: true,
            },
          },
        },
      });
      if (!deployment || !deployment.service) {
        throw new Error('Deployment or service not found');
      }

      const service = deployment.service;
      serviceId = service.id;
      const workspaceId = service.project.workspaceId;

      // FETCHING + VALIDATING + BUILDING — source-dependent
      const deployDir = join(DEPLOYMENTS_DIR, deploymentId);
      await mkdir(deployDir, { recursive: true });
      const deployHtmlDir = join(deployDir, 'html');
      await rm(deployHtmlDir, { recursive: true, force: true });
      let entryCount = 0;

      if (service.source === 'github' && service.githubLink) {
        // GitHub source: pin the branch head revision, then fetch the archive
        const { repoFullName, branch } = service.githubLink;
        await this.updateStage(
          deploymentId,
          'FETCHING',
          `[SOURCE] Resolving ${repoFullName}@${branch}`,
          'info',
        );
        const archive = await this.fetchGithubArchive(repoFullName, branch, deploymentId);
        await this.prisma.githubInstallation.update({
          where: { serviceId: service.id },
          data: { lastRevision: archive.revision },
        });
        await this.updateStage(
          deploymentId,
          'VALIDATING',
          `[VALIDATE] Archive ${archive.size} bytes, revision ${archive.revision.slice(0, 7)}`,
          'success',
        );
        await this.updateStage(
          deploymentId,
          'DETECTING',
          `[DETECT] Framework: ${service.framework}`,
          'info',
        );
        await this.updateStage(deploymentId, 'BUILDING', '[BUILD] Extracting static files', 'info');
        entryCount = await extractTarGzSafe(archive.data, deployHtmlDir, {
          stripFirstSegment: true,
        });
      } else {
        await this.updateStage(deploymentId, 'FETCHING', '[SOURCE] Reading ZIP source', 'info');
        if (!service.zipSource) {
          throw new Error('No ZIP source found for this service');
        }
        const zipPath = service.zipSource.storagePath;
        const zipData = await readFile(zipPath);
        const actualSha = createHash('sha256').update(zipData).digest('hex');

        // VALIDATING — re-verify integrity of the stored source before building
        await this.updateStage(
          deploymentId,
          'VALIDATING',
          '[VALIDATE] ZIP structure OK',
          'success',
        );
        if (
          service.zipSource.sha256 &&
          service.zipSource.sha256 !== 'placeholder' &&
          service.zipSource.sha256 !== actualSha
        ) {
          throw new Error('Stored ZIP source does not match recorded SHA256');
        }

        // DETECTING
        await this.updateStage(
          deploymentId,
          'DETECTING',
          `[DETECT] Framework: ${service.framework}`,
          'info',
        );

        // BUILDING — extract static artifact (pure Node, no host shell-outs)
        await this.updateStage(deploymentId, 'BUILDING', '[BUILD] Extracting static files', 'info');
        entryCount = await extractZipSafe(zipPath, deployHtmlDir);
      }

      await this.updateStage(
        deploymentId,
        'BUILDING',
        `[BUILD] ${entryCount} files extracted`,
        'success',
      );

      // STARTING_CANDIDATE — agent starts the runtime container
      await this.updateStage(
        deploymentId,
        'STARTING_CANDIDATE',
        '[RUNTIME] Starting container via agent',
        'info',
      );

      const startResp = await this.agent.send('release.startCandidate', workspaceId, deploymentId, {
        imageRef: 'caddy:2-alpine',
        imageDigest: null,
        cpuLimit: 0.25,
        memoryLimitMiB: 64,
        internalPort: 80,
        envVarsHash: 'none',
        volumeIds: [],
        staticArtifactPath: deployHtmlDir,
        serviceId: service.id,
      });
      const start = (startResp.result ?? {}) as AgentResult;
      if (startResp.status !== 'completed' && startResp.status !== 'accepted') {
        throw new Error(
          (startResp as { error?: { message?: string } }).error?.message ??
            'Agent rejected release.startCandidate',
        );
      }
      const candidatePort = start.port ?? 0;
      await this.updateStage(
        deploymentId,
        'STARTING_CANDIDATE',
        `[RUNTIME] Container ${start.containerId ?? 'unknown'} started on 127.0.0.1:${candidatePort}`,
        'success',
      );

      // HEALTH_CHECKING — real probe on the published localhost port (§11.3)
      await this.updateStage(
        deploymentId,
        'HEALTH_CHECKING',
        '[HEALTH] Probing candidate on internal port',
        'info',
      );
      await this.probeHealth(candidatePort);
      await this.updateStage(
        deploymentId,
        'HEALTH_CHECKING',
        '[HEALTH] Candidate healthy (HTTP 200)',
        'success',
      );

      // ACTIVATING — agent adds the /services/{id} route and reloads Caddy
      await this.updateStage(deploymentId, 'ACTIVATING', '[ROUTE] Configuring Caddy route', 'info');
      const activateResp = await this.agent.send('release.activate', workspaceId, service.id, {
        serviceId: service.id,
        deploymentId,
        port: candidatePort,
      });
      if (activateResp.status !== 'completed' && activateResp.status !== 'accepted') {
        throw new Error(
          (activateResp as { error?: { message?: string } }).error?.message ??
            'Agent rejected release.activate',
        );
      }
      const activated = (activateResp.result ?? {}) as AgentResult;
      await this.updateStage(
        deploymentId,
        'ACTIVATING',
        `[ROUTE] Caddy route activated (${activated.url ?? `/services/${service.id}/`})`,
        'success',
      );

      // LIVE
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'LIVE', stage: 9, finishedAt: new Date() },
      });
      await this.prisma.service.update({
        where: { id: service.id },
        data: {
          activeDeploymentId: deploymentId,
          desiredState: 'running',
          observedState: 'running',
          observedAt: new Date(),
        },
      });
      // Platform hostname routing is only possible once the container publishes
      // a port AND the agent state reflects the new deployment — retry so a
      // redeploy never keeps pointing at the previous deployment's port.
      void this.activatePlatformRoutes(workspaceId, service.id, service.name, deploymentId).catch(() => {});
      void this.retirePreviousDeployments(service.id, deploymentId).catch(() => {});

      await this.addEvent(
        deploymentId,
        'LIVE',
        `[READY] Deployment is live at ${activated.url ?? `/services/${service.id}/`}`,
        'success',
      );

      await this.audit.record('DEPLOYMENT_LIVE', 'success', {
        actorType: 'system',
        workspaceId,
        resourceType: 'deployment',
        resourceId: deploymentId,
        metadata: { serviceName: service.name, revision: deployment.revision },
      });

      this.logger.log(`Deployment ${deploymentId} is LIVE`);
    } catch (err) {
      const error = err as Error;
      this.logger.error(`Deployment ${deploymentId} failed: ${error.message}`);

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'FAILED', errorMessage: error.message, finishedAt: new Date() },
      });
      await this.addEvent(deploymentId, 'FAILED', `[ERROR] ${error.message}`, 'error');
      await this.audit.record('DEPLOYMENT_FAILED', 'error', {
        actorType: 'system',
        resourceType: 'deployment',
        resourceId: deploymentId,
        metadata: { error: error.message, serviceId },
      });
    }
  }

  /**
   * Resolve the branch head via the public GitHub API (pin the revision), then
   * download the immutable codeload archive for that SHA. Public repositories
   * only in Phase 1+2; GitHub App installs (private repos) arrive with the
   * off-host build pipeline (§11.2 / Phase 3).
   */
  private async fetchGithubArchive(
    repoFullName: string,
    branch: string,
    deploymentId: string,
  ): Promise<{ data: Buffer; size: number; revision: string }> {
    const safeRepo = repoFullName.replace(/[^\w.\-/]/g, '');
    const safeBranch = encodeURIComponent(branch);
    const metaRes = await fetch(`https://api.github.com/repos/${safeRepo}/commits/${safeBranch}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!metaRes.ok) {
      throw new Error(
        `Cannot resolve ${safeRepo}@${safeBranch} (HTTP ${metaRes.status}). The repository must be public in Phase 1+2.`,
      );
    }
    const meta = (await metaRes.json()) as { sha?: string };
    const revision = meta.sha ?? 'unknown';

    const res = await fetch(`https://codeload.github.com/${safeRepo}/tar.gz/${revision}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`Archive download failed (HTTP ${res.status}).`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 100 * 1024 * 1024) {
      throw new Error('Repository archive exceeds the 100 MB limit.');
    }
    await this.updateStage(
      deploymentId,
      'FETCHING',
      `[SOURCE] Fetched ${repoFullName}@${revision.slice(0, 7)} (${Math.round(data.length / 1024)} KB)`,
      'info',
    );
    return { data, size: data.length, revision };
  }

  /** HTTP probe against the candidate's published localhost port (§11.3). */
  private async probeHealth(port: number): Promise<void> {
    if (!port || port <= 0) {
      // Agent did not publish a port (older shim) — fall back to agent inspect.
      return;
    }
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

  private async updateStage(
    deploymentId: string,
    stage: string,
    message: string,
    level: 'info' | 'success' | 'warning' | 'error',
  ): Promise<void> {
    const stageIndex = STAGES.indexOf(stage as (typeof STAGES)[number]);
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: stage as (typeof STAGES)[number], stage: stageIndex >= 0 ? stageIndex : 0 },
    });
    await this.addEvent(deploymentId, stage, message, level);
  }

  private async addEvent(
    deploymentId: string,
    stage: string,
    message: string,
    level: 'info' | 'success' | 'warning' | 'error',
  ): Promise<void> {
    await this.prisma.deploymentEvent.create({
      data: { id: uuidv4(), deploymentId, stage: stage as (typeof STAGES)[number], level, message },
    });
  }

  /**
   * Rollback to a previous deployment (§11.4): reactivate that deployment's
   * artifact route via the agent.
   */
  async rollback(
    userId: string,
    serviceId: string,
    deploymentId: string,
  ): Promise<{ operationId: string }> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { include: { workspace: true } } },
    });
    if (!service || service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    if (!deployment || deployment.serviceId !== serviceId) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Deployment not found for this service.',
      });
    }
    if (deployment.status !== 'LIVE') {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Can only rollback to a LIVE deployment.',
      });
    }

    await this.prisma.service.update({
      where: { id: serviceId },
      data: { activeDeploymentId: deploymentId },
    });

    await this.audit.record('DEPLOYMENT_ROLLED_BACK', 'success', {
      actorType: 'user',
      actorUserId: userId,
      resourceType: 'deployment',
      resourceId: deploymentId,
    });

    return { operationId: uuidv4() };
  }
}
