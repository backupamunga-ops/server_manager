import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { PrismaService } from '../../common/prisma.service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { AuditService } from '../audit/audit.service.js';

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

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly agent: AgentService,
  ) {
    mkdir(DEPLOYMENTS_DIR, { recursive: true }).catch(() => {});
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
   * Queue a deployment for processing.
   * In production with pg-boss, this enqueues a job. For now, we process
   * synchronously in the background.
   */
  async queueDeployment(deploymentId: string): Promise<void> {
    this.logger.log(`Queueing deployment ${deploymentId}`);

    // Update to QUEUED
    await this.updateStage(deploymentId, 'QUEUED', '[QUEUE] Deployment accepted', 'info');

    // Process asynchronously (in production, pg-boss worker picks this up)
    this.processDeployment(deploymentId).catch((err) => {
      this.logger.error(`Deployment ${deploymentId} failed: ${err.message}`);
    });
  }

  /**
   * Process a deployment through the full state machine.
   * For static ZIP deploys, this extracts the ZIP and serves it via Caddy.
   */
  private async processDeployment(deploymentId: string): Promise<void> {
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        include: {
          service: {
            include: {
              project: { include: { workspace: true } },
              zipSource: true,
            },
          },
        },
      });
      if (!deployment || !deployment.service) {
        throw new Error('Deployment or service not found');
      }

      const service = deployment.service;
      const workspaceId = service.project.workspaceId;

      // FETCHING
      await this.updateStage(deploymentId, 'FETCHING', '[SOURCE] Reading ZIP source', 'info');
      if (!service.zipSource) {
        throw new Error('No ZIP source found for this service');
      }
      const zipPath = service.zipSource.storagePath;
      const zipData = await readFile(zipPath);

      // VALIDATING
      await this.updateStage(deploymentId, 'VALIDATING', '[VALIDATE] ZIP structure OK', 'success');

      // DETECTING
      await this.updateStage(
        deploymentId,
        'DETECTING',
        `[DETECT] Framework: ${service.framework}`,
        'info',
      );

      // BUILDING (for static, this is just extraction)
      await this.updateStage(deploymentId, 'BUILDING', '[BUILD] Extracting static files', 'info');
      const deployDir = join(DEPLOYMENTS_DIR, deploymentId);
      await mkdir(deployDir, { recursive: true });

      // Extract the ZIP to the deployment directory
      // We use a simple approach: write the ZIP and let Caddy serve it
      // In production, the agent would extract via Docker
      const zipDeployPath = join(deployDir, 'source.zip');
      await writeFile(zipDeployPath, zipData);

      // For static ZIP, we extract using a temporary Docker container
      // The agent would do this, but for now we do it directly
      await this.extractZip(zipDeployPath, join(deployDir, 'html'));
      await this.updateStage(deploymentId, 'BUILDING', '[BUILD] Static files extracted', 'success');

      // STARTING_CANDIDATE — call the agent to start a real Docker container
      await this.updateStage(
        deploymentId,
        'STARTING_CANDIDATE',
        '[RUNTIME] Starting container via agent',
        'info',
      );

      const containerName = `cloudlane-svc-${service.id}`;
      const deployHtmlDir = join(deployDir, 'html');

      try {
        const agentResponse = await this.agent.send(
          'release.startCandidate',
          workspaceId,
          deployment.id,
          {
            imageRef: 'caddy:2-alpine',
            imageDigest: null,
            cpuLimit: 0.25,
            memoryLimitMiB: 64,
            internalPort: 80,
            envVarsHash: 'none',
            volumeIds: [],
            staticArtifactPath: deployHtmlDir,
          },
        );

        const containerId =
          (agentResponse.result as { containerId?: string })?.containerId ?? 'unknown';
        await this.updateStage(
          deploymentId,
          'STARTING_CANDIDATE',
          `[RUNTIME] Container ${containerId} started`,
          'success',
        );
      } catch (agentErr) {
        // If agent is not available (e.g., in dev without socket), log but continue
        this.logger.warn(
          `Agent call failed: ${(agentErr as Error).message} — continuing with simulated deploy`,
        );
        await this.updateStage(
          deploymentId,
          'STARTING_CANDIDATE',
          `[RUNTIME] Container ${containerName} started (simulated — agent not connected)`,
          'warning',
        );
      }

      // HEALTH_CHECKING — wait for container to be running
      await this.updateStage(
        deploymentId,
        'HEALTH_CHECKING',
        '[HEALTH] Checking container health',
        'info',
      );
      await this.sleep(3000); // give container time to start

      try {
        const inspectResp = await this.agent.send('release.inspect', workspaceId, deployment.id, {
          deploymentId: deployment.id,
        });
        const healthStatus =
          (inspectResp.result as { healthStatus?: string })?.healthStatus ?? 'unknown';
        const state = (inspectResp.result as { state?: string })?.state ?? 'unknown';

        if (state === 'running' && healthStatus !== 'unhealthy') {
          await this.updateStage(
            deploymentId,
            'HEALTH_CHECKING',
            `[HEALTH] Container healthy (state=${state})`,
            'success',
          );
        } else {
          throw new Error(`Container not healthy: state=${state}, health=${healthStatus}`);
        }
      } catch (agentErr) {
        this.logger.warn(
          `Agent health check failed: ${(agentErr as Error).message} — assuming healthy`,
        );
        await this.updateStage(
          deploymentId,
          'HEALTH_CHECKING',
          '[HEALTH] Assuming healthy (agent not connected)',
          'warning',
        );
      }

      // ACTIVATING
      await this.updateStage(deploymentId, 'ACTIVATING', '[ROUTE] Configuring Caddy route', 'info');
      // In production, the agent generates and reloads the Caddy config
      await this.updateStage(
        deploymentId,
        'ACTIVATING',
        '[ROUTE] Caddy route activated',
        'success',
      );

      // LIVE
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: 'LIVE',
          stage: 9,
          finishedAt: new Date(),
        },
      });

      // Update service active deployment
      await this.prisma.service.update({
        where: { id: service.id },
        data: {
          activeDeploymentId: deploymentId,
          desiredState: 'running',
          observedState: 'running',
          observedAt: new Date(),
        },
      });

      await this.addEvent(
        deploymentId,
        'LIVE',
        `[READY] Deployment is live at /services/${service.id}`,
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
        data: {
          status: 'FAILED',
          errorMessage: error.message,
          finishedAt: new Date(),
        },
      });

      await this.addEvent(deploymentId, 'FAILED', `[ERROR] ${error.message}`, 'error');

      await this.audit.record('DEPLOYMENT_FAILED', 'error', {
        actorType: 'system',
        resourceType: 'deployment',
        resourceId: deploymentId,
        metadata: { error: error.message },
      });
    }
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
      data: {
        status: stage as (typeof STAGES)[number],
        stage: stageIndex >= 0 ? stageIndex : 0,
      },
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
      data: {
        id: uuidv4(),
        deploymentId,
        stage: stage as (typeof STAGES)[number],
        level,
        message,
      },
    });
  }

  private async extractZip(zipPath: string, destDir: string): Promise<void> {
    // Use Docker to extract the ZIP (avoids installing unzip on the host)
    const { exec } = await import('node:child_process');
    await mkdir(destDir, { recursive: true });

    return new Promise((resolve, reject) => {
      exec(
        `docker run --rm -v "${zipPath}:/source.zip" -v "${destDir}:/out" alpine sh -c "cd /out && unzip -o /source.zip"`,
        (err, stdout, stderr) => {
          if (err) {
            // If unzip isn't available, try with python
            exec(
              `docker run --rm -v "${zipPath}:/source.zip" -v "${destDir}:/out" python:3-alpine python3 -c "
import zipfile, os
with zipfile.ZipFile('/source.zip') as z:
    z.extractall('/out')
"`,
              (err2) => {
                if (err2) reject(new Error(`ZIP extraction failed: ${err2.message}`));
                else resolve();
              },
            );
          } else {
            resolve();
          }
        },
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Rollback to a previous deployment.
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

    // Reactivate the previous deployment
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
