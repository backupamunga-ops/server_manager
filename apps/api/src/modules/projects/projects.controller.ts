import type { SessionInfo } from '@cloudlane/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import type { ProjectsService } from './projects.service.js';

class CreateProjectDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  slug?: string;
}

@ApiTags('projects')
@Controller('projects')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  async list(@CurrentUser() user: SessionInfo) {
    return { items: await this.projects.listForOwner(user.userId) };
  }

  @Get(':projectId')
  async get(@Param('projectId') projectId: string, @CurrentUser() user: SessionInfo) {
    return await this.projects.getForOwner(user.userId, projectId);
  }

  @Post()
  @HttpCode(201)
  @UsePipes(new ValidationPipe({ transform: true }))
  async create(@Body() body: CreateProjectDto, @CurrentUser() user: SessionInfo) {
    return await this.projects.create(user.userId, body.name, body.slug);
  }

  @Delete(':projectId')
  @HttpCode(200)
  async delete(@Param('projectId') projectId: string, @CurrentUser() user: SessionInfo) {
    await this.projects.delete(user.userId, projectId);
    return { ok: true };
  }
}
