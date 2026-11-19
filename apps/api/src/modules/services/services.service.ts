import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DeploymentsService } from '../deployments/deployments.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { UploadsService } from '../uploads/uploads.service.js';

const serviceNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

@Injectable()
export class ServicesService {
  private readonly logger = new Logger(ServicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deployments: DeploymentsService,
    private readonly uploads: UploadsService,
    private readonly secrets: SecretsService,
  ) {}

  async getForOwner(userId: string, serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        project: { include: { workspace: true } },
        variables: { select: { key: true } },
        githubLink: true,
        zipSource: true,
        activeDeployment: true,
      },
    });
    if (!service || service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }
    return {
      id: service.id,
      name: service.name,
      kind: service.kind,
      role: service.role,
      source: service.source,
      framework: service.framework,
      status: service.desiredState,
      activeDeploymentId: service.activeDeploymentId,
      createdAt: service.createdAt.toISOString(),
      projectId: service.projectId,
      environmentId: service.environmentId,
      variables: service.variables.map((v) => ({ key: v.key })),
      githubLink: service.githubLink
        ? {
            repoFullName: service.githubLink.repoFullName,
            branch: service.githubLink.branch,
            autoDeploy: service.githubLink.autoDeploy,
            lastRevision: service.githubLink.lastRevision,
          }
        : undefined,
      zipSource: service.zipSource
        ? {
            sha256: service.zipSource.sha256,
            fileSize: Number(service.zipSource.fileSize),
            entryCount: service.zipSource.entryCount,
            detectedFramework: service.zipSource.detectedFramework,
          }
        : undefined,
      activeDeployment: service.activeDeployment
        ? {
            id: service.activeDeployment.id,
            status: service.activeDeployment.status,
            revision: service.activeDeployment.revision,
            startedAt: service.activeDeployment.startedAt.toISOString(),
            finishedAt: service.activeDeployment.finishedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  /**
   * Create a service from a ZIP upload and trigger its first deployment.
   */
  async createFromZip(
    userId: string,
    projectId: string,
    name: string,
    role: 'web' | 'api' | 'worker' | 'static',
    uploadId: string,
    frameworkOverride?: string,
  ): Promise<{ serviceId: string; deploymentId: string }> {
    // Validate name
    if (!serviceNamePattern.test(name)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Service name must be 1-49 chars, lowercase alphanumeric + hyphens.',
      });
    }

    // Verify project ownership and get environment
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      include: {
        workspace: true,
        environments: true,
        services: { where: { name } },
      },
    });
    if (!project || project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found.' });
    }
    if (project.services.length > 0) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: `Service "${name}" already exists in this project.`,
      });
    }

    const env = project.environments.find((e) => e.name === 'production');
    if (!env) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Production environment not found.',
      });
    }

    // Persist the upload into the permanent sources store and read its metadata
    const staged = await this.uploads.persist(uploadId);
    const entryCount = this.uploads.getEntryCount(uploadId);

    // Determine framework
    const framework = frameworkOverride || 'Static HTML';

    const serviceId = uuidv4();
    const deploymentId = uuidv4();

    // Atomic: create service + zip source + deployment
    const result: { service: { id: string }; deployment: { id: string } } =
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.service.create({
          data: {
            id: serviceId,
            projectId,
            environmentId: env.id,
            name,
            kind: 'application',
            role,
            source: 'zip',
            framework,
            desiredState: 'deploying',
            observedState: 'pending',
            zipSource: {
              create: {
                storagePath: staged.path,
                sha256: staged.sha256,
                fileSize: BigInt(staged.size),
                entryCount,
                detectedFramework: framework,
              },
            },
          },
        });

        const deployment = await tx.deployment.create({
          data: {
            id: deploymentId,
            serviceId: created.id,
            status: 'REQUESTED',
            stage: 0,
            revision: `zip-${Date.now().toString(36)}`,
          },
        });

        return { service: created, deployment };
      });

    // Queue the deployment for processing
    await this.deployments.queueDeployment(result.deployment.id);

    await this.audit.record('SERVICE_CREATED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      resourceType: 'service',
      resourceId: serviceId,
      metadata: { name, source: 'zip', framework },
    });

    // Clean up the upload staging

    return { serviceId, deploymentId };
  }

  /**
   * Create a service from a GitHub repo (CL-055 — full implementation later).
   */
  async createFromGithub(
    userId: string,
    projectId: string,
    name: string,
    role: 'web' | 'api' | 'worker' | 'static',
    installationId: number,
    repoFullName: string,
    branch: string,
    autoDeploy: boolean,
  ): Promise<{ serviceId: string; deploymentId: string }> {
    // Validate name
    if (!serviceNamePattern.test(name)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Service name must be 1-49 chars, lowercase alphanumeric + hyphens.',
      });
    }
    // Validate repository coordinates (owner/repo; public repos in Phase 1+2)
    if (!/^[\w.-]+\/[\w.-]+$/.test(repoFullName)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Repository must be in owner/repo form.',
      });
    }
    if (!/^[\w.\-/]+$/.test(branch)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Branch name contains unsupported characters.',
      });
    }

    // Verify project ownership and get environment (same rules as ZIP flow)
    const project = await this.prisma.project.findFirst({
      where: { id: projectId },
      include: {
        workspace: true,
        environments: true,
        services: { where: { name } },
      },
    });
    if (!project || project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found.' });
    }
    if (project.services.length > 0) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: `Service "${name}" already exists in this project.`,
      });
    }
    const env = project.environments.find((e) => e.name === 'production');
    if (!env) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Production environment not found.',
      });
    }

    // installationId 0 = no GitHub App install; Phase 1+2 fetches public repos.
    const effectiveInstallationId = installationId > 0 ? installationId : 0;
    const framework = 'Static HTML';

    const serviceId = uuidv4();
    const deploymentId = uuidv4();

    const created = await this.prisma.$transaction(async (tx) => {
      const svc = await tx.service.create({
        data: {
          id: serviceId,
          projectId,
          environmentId: env.id,
          name,
          kind: 'application',
          role,
          source: 'github',
          framework,
          desiredState: 'deploying',
          observedState: 'pending',
          githubLink: {
            create: {
              installationId: effectiveInstallationId,
              repoFullName,
              branch,
              autoDeploy,
            },
          },
        },
      });
      const deployment = await tx.deployment.create({
        data: {
          id: deploymentId,
          serviceId: svc.id,
          status: 'REQUESTED',
          stage: 0,
          revision: `gh-${Date.now().toString(36)}`,
        },
      });
      return { service: svc, deployment };
    });

    await this.deployments.queueDeployment(created.deployment.id);

    await this.audit.record('SERVICE_CREATED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      resourceType: 'service',
      resourceId: serviceId,
      metadata: { name, source: 'github', repoFullName, branch },
    });

    return { serviceId, deploymentId };
  }

  /** Verify ownership and return the service with its project/workspace. */
  private async requireOwnedService(userId: string, serviceId: string) {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { include: { workspace: true } } },
    });
    if (!service || service.project.workspace.ownerId !== userId) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }
    return service;
  }

  /** List environment variables with decrypted values (owner only). */
  async listVariables(userId: string, serviceId: string) {
    await this.requireOwnedService(userId, serviceId);
    const rows = await this.prisma.serviceVariable.findMany({
      where: { serviceId },
      orderBy: { key: 'asc' },
    });
    return rows.map((v) => ({
      key: v.key,
      value: this.secrets.decrypt(v.encryptedValue),
      updatedAt: v.updatedAt.toISOString(),
    }));
  }

  /** Create or update one environment variable (owner only, step-up required). */
  async setVariable(userId: string, serviceId: string, key: string, value: string) {
    const service = await this.requireOwnedService(userId, serviceId);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > 128) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Variable key must match [A-Za-z_][A-Za-z0-9_]* (max 128 chars).',
      });
    }
    if (value.length > 8192) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Variable value exceeds 8192 characters.',
      });
    }
    await this.prisma.serviceVariable.upsert({
      where: { serviceId_key: { serviceId, key } },
      create: { serviceId, key, encryptedValue: this.secrets.encrypt(value) },
      update: { encryptedValue: this.secrets.encrypt(value) },
    });
    await this.audit.record('SERVICE_VARIABLE_SET', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId: service.project.workspaceId,
      resourceType: 'service',
      resourceId: serviceId,
      metadata: { key },
    });
    return { key, set: true };
  }

  /** Delete one environment variable (owner only, step-up required). */
  async deleteVariable(userId: string, serviceId: string, key: string) {
    const service = await this.requireOwnedService(userId, serviceId);
    await this.prisma.serviceVariable.deleteMany({ where: { serviceId, key } });
    await this.audit.record('SERVICE_VARIABLE_DELETED', 'success', {
      actorType: 'user',
      actorUserId: userId,
      workspaceId: service.project.workspaceId,
      resourceType: 'service',
      resourceId: serviceId,
      metadata: { key },
    });
    return { key, deleted: true };
  }
}
