import type { SessionInfo } from '@cloudlane/contracts';
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import type { ServicesService } from './services.service.js';

class CreateZipServiceDto {
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/)
  name!: string;

  @IsEnum(['web', 'api', 'worker', 'static'])
  role!: 'web' | 'api' | 'worker' | 'static';

  @IsString() uploadId!: string;

  @IsOptional() @IsString() framework?: string;
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
    @Body() body: CreateZipServiceDto,
    @CurrentUser() user: SessionInfo,
  ) {
    return await this.services.createFromZip(
      user.userId,
      projectId,
      body.name,
      body.role,
      body.uploadId,
      body.framework,
    );
  }

  @Get(':serviceId')
  async get(@Param('serviceId') serviceId: string, @CurrentUser() user: SessionInfo) {
    return await this.services.getForOwner(user.userId, serviceId);
  }
}
