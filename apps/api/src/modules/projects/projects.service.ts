import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listForOwner(ownerId: string) {
    const workspace = await this.getOrCreateWorkspace(ownerId);
    const projects = await this.prisma.project.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { services: true } } },
    });
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      serviceCount: p._count.services,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async getForOwner(ownerId: string, projectId: string) {
    const workspace = await this.getOrCreateWorkspace(ownerId);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId: workspace.id },
      include: {
        services: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            kind: true,
            role: true,
            source: true,
            framework: true,
            desiredState: true,
            activeDeploymentId: true,
            createdAt: true,
          },
        },
      },
    });
    if (!project) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found.' });
    }
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      serviceCount: project.services.length,
      createdAt: project.createdAt.toISOString(),
      services: project.services.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        role: s.role,
        source: s.source,
        framework: s.framework,
        status: s.desiredState,
        activeDeploymentId: s.activeDeploymentId,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  }

  async create(ownerId: string, name: string, slugInput?: string) {
    if (!name || name.length < 2 || name.length > 64) {
      throw new ConflictException({
        code: 'VALIDATION_ERROR',
        message: 'Project name must be 2-64 characters.',
      });
    }
    const slug = slugInput ? slugInput.toLowerCase() : slugify(name);
    if (!slugPattern.test(slug)) {
      throw new ConflictException({
        code: 'VALIDATION_ERROR',
        message: 'Slug must be 1-63 chars, alphanumeric + hyphens.',
      });
    }

    const workspace = await this.getOrCreateWorkspace(ownerId);

    const existing = await this.prisma.project.findUnique({
      where: { workspaceId_slug: { workspaceId: workspace.id, slug } },
    });
    if (existing) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: `Project with slug "${slug}" already exists.`,
      });
    }

    const projectId = uuidv4();
    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          id: projectId,
          workspaceId: workspace.id,
          name,
          slug,
        },
      });
      // Create default production environment
      await tx.environment.create({
        data: {
          projectId: created.id,
          name: 'production',
        },
      });
      return created;
    });

    await this.audit.record('PROJECT_CREATED', 'success', {
      actorType: 'user',
      actorUserId: ownerId,
      workspaceId: workspace.id,
      resourceType: 'project',
      resourceId: project.id,
    });

    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
    };
  }

  async delete(ownerId: string, projectId: string) {
    const workspace = await this.getOrCreateWorkspace(ownerId);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId: workspace.id },
    });
    if (!project) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found.' });
    }

    await this.prisma.project.delete({ where: { id: projectId } });

    await this.audit.record('PROJECT_DELETED', 'success', {
      actorType: 'user',
      actorUserId: ownerId,
      workspaceId: workspace.id,
      resourceType: 'project',
      resourceId: projectId,
    });
  }

  private async getOrCreateWorkspace(ownerId: string) {
    let ws = await this.prisma.workspace.findUnique({ where: { ownerId } });
    if (!ws) {
      // Bootstrap should have created one, but handle the case
      const user = await this.prisma.user.findUnique({ where: { id: ownerId } });
      if (!user) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'User not found.' });
      ws = await this.prisma.workspace.create({
        data: { ownerId, name: `${user.email}'s workspace` },
      });
    }
    return ws;
  }
}
