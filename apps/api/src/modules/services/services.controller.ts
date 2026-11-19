import type { SessionInfo } from '@cloudlane/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { RequireStepUp, StepUpGuard } from '../../common/guards/step-up.guard.js';
import { ServicesService } from './services.service.js';

class CreateServiceDto {
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/)
  name!: string;

  @IsEnum(['web', 'api', 'worker', 'static'])
  role!: 'web' | 'api' | 'worker' | 'static';

  @IsEnum(['zip', 'github'])
  source!: 'zip' | 'github';

  @IsOptional() @IsString() uploadId!: string;

  @IsOptional() @IsString() framework?: string;

  @IsOptional() @IsString() repoFullName!: string;

  @IsOptional() @IsString() branch!: string;

  @IsOptional() installationId?: number;

  @IsOptional() autoDeploy?: boolean;
}

@ApiTags('services')
@Controller('projects/:projectId/services')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Post()
  @UsePipes(new ValidationPipe({ transform: true }))
  async create(
    @Param('projectId') projectId: string,
    @Body() body: CreateServiceDto,
    @CurrentUser() user: SessionInfo,
  ) {
    if (body.source === 'github') {
      return await this.services.createFromGithub(
        user.userId,
        projectId,
        body.name,
        body.role,
        body.installationId ?? 0,
        body.repoFullName ?? '',
        body.branch ?? 'main',
        body.autoDeploy ?? true,
      );
    }
    return await this.services.createFromZip(
      user.userId,
      projectId,
      body.name,
      body.role,
      body.uploadId ?? '',
      body.framework,
    );
  }
}

class SetVariableDto {
  @IsString()
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*$/)
  key!: string;

  @IsString() value!: string;
}

/**
 * Service-scoped endpoints (build plan §4.3): detail + environment variables.
 * Deployments, logs and rollbacks live in DeploymentsController.
 */
@ApiTags('services')
@Controller('services/:serviceId')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class ServiceDetailController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  async detail(@Param('serviceId') serviceId: string, @CurrentUser() user: SessionInfo) {
    return await this.services.getForOwner(user.userId, serviceId);
  }

  @Get('db-admin')
  async dbAdminLink(@Param('serviceId') serviceId: string, @CurrentUser() user: SessionInfo) {
    return await this.services.dbAdminLink(user.userId, serviceId);
  }

  @Get('variables')
  async listVariables(@Param('serviceId') serviceId: string, @CurrentUser() user: SessionInfo) {
    return { items: await this.services.listVariables(user.userId, serviceId) };
  }

  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @UsePipes(new ValidationPipe({ transform: true }))
  @Post('variables')
  async setVariable(
    @Param('serviceId') serviceId: string,
    @Body() body: SetVariableDto,
    @CurrentUser() user: SessionInfo,
  ) {
    return await this.services.setVariable(user.userId, serviceId, body.key, body.value);
  }

  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Delete('variables/:key')
  async deleteVariable(
    @Param('serviceId') serviceId: string,
    @Param('key') key: string,
    @CurrentUser() user: SessionInfo,
  ) {
    return await this.services.deleteVariable(user.userId, serviceId, key);
  }
}
