import { arch, freemem, hostname, uptime as osUptime, platform, totalmem } from 'node:os';
import type { SessionInfo } from '@cloudlane/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { PrismaService } from '../../common/prisma.service.js';

const VERSION = '0.1.0';

/**
 * Workspace overview (real counts and health, no simulated success —
 * master guide §622 "Overview" journey) and server facts for Settings → Server.
 */
@ApiTags('overview')
@Controller()
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class OverviewController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  async overview(@CurrentUser() user: SessionInfo) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { ownerId: user.userId },
      include: {
        projects: {
          include: { services: { include: { activeDeployment: true } } },
        },
      },
    });
    if (!workspace) {
      return {
        workspace: null,
        stats: { projects: 0, services: 0, live: 0, failed: 0 },
        projects: [],
      };
    }

    const services = workspace.projects.flatMap((p) => p.services);
    const live = services.filter((s) => s.activeDeployment?.status === 'LIVE').length;
    const failed = services.filter((s) => s.observedState === 'failed').length;

    const recentAudit = await this.prisma.auditEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    return {
      workspace: { id: workspace.id, name: workspace.name },
      stats: {
        projects: workspace.projects.length,
        services: services.length,
        live,
        failed,
      },
      projects: workspace.projects.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        createdAt: p.createdAt.toISOString(),
        services: p.services.map((s) => ({
          id: s.id,
          name: s.name,
          framework: s.framework,
          source: s.source,
          observedState: s.observedState,
          activeDeploymentId: s.activeDeploymentId,
          activeDeploymentStatus: s.activeDeployment?.status ?? null,
          url: s.activeDeployment?.status === 'LIVE' ? `/services/${s.id}/` : null,
        })),
      })),
      recentActivity: recentAudit.map((e) => ({
        id: e.id,
        action: e.action,
        status: e.status,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  @Get('server/info')
  async serverInfo() {
    return {
      version: VERSION,
      hostname: hostname(),
      platform: `${platform()} ${arch()}`,
      uptimeSeconds: Math.round(osUptime()),
      memoryTotalMiB: Math.round(totalmem() / 1024 / 1024),
      memoryFreeMiB: Math.round(freemem() / 1024 / 1024),
      nodeVersion: process.version,
    };
  }
}
