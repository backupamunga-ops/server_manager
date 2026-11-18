import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DeploymentsService } from './deployments.service.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { SessionInfo } from '@cloudlane/contracts';

@ApiTags('deployments')
@Controller('services/:serviceId/deployments')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Get()
  async list(@Param('serviceId') serviceId: string, @CurrentUser() user: SessionInfo) {
    return { items: await this.deployments.listForService(user.userId, serviceId) };
  }

  @Get(':deploymentId/events')
  async events(@Param('deploymentId') deploymentId: string, @CurrentUser() user: SessionInfo) {
    return { items: await this.deployments.getEvents(user.userId, deploymentId) };
  }
}
