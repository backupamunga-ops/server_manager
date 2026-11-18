import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service.js';

@Injectable()
export class DeploymentsService {
  constructor(private readonly prisma: PrismaService) {}

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
}
