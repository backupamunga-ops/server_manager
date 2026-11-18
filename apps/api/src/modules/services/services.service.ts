import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async getForOwner(userId: string, serviceId: string) {
    // Verify ownership via project.workspace.ownerId
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
    if (!service) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Service not found.' });
    }
    if (service.project.workspace.ownerId !== userId) {
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
}
