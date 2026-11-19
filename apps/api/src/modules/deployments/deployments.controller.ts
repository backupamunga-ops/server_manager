import type { SessionInfo } from '@cloudlane/contracts';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { RequireStepUp, StepUpGuard } from '../../common/guards/step-up.guard.js';
import type { DeploymentsService } from './deployments.service.js';

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
