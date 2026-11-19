import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DeploymentsService } from './deployments.service.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { StepUpGuard, RequireStepUp } from '../../common/guards/step-up.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { SessionInfo } from '@cloudlane/contracts';
import { IsString } from 'class-validator';

class RollbackDto {
  @IsString() deploymentId!: string;
}

@ApiTags('deployments')
@Controller('services/:serviceId')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Get('deployments')
  async list(@Param('serviceId') serviceId: string, @CurrentUser() user: SessionInfo) {
    return { items: await this.deployments.listForService(user.userId, serviceId) };
  }

  @Get('deployments/:deploymentId/events')
  async events(@Param('deploymentId') deploymentId: string, @CurrentUser() user: SessionInfo) {
    return { items: await this.deployments.getEvents(user.userId, deploymentId) };
  }

  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Post('rollbacks')
  async rollback(
    @Param('serviceId') serviceId: string,
    @Body() body: RollbackDto,
    @CurrentUser() user: SessionInfo,
  ) {
    return await this.deployments.rollback(user.userId, serviceId, body.deploymentId);
  }
}
