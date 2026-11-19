import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsString } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { WorkspaceService } from './workspace.service.js';

class ActionDto {
  @IsString() type!: string;
  @IsObject() payload!: Record<string, unknown>;
}

/**
 * Workspace aggregate + prototype action surface. The faithful UI reads the
 * aggregate and dispatches mutations here; pipeline-specific endpoints
 * (uploads, deployments, variables, domains/:id/verify) remain the real paths.
 */
@ApiTags('workspace')
@Controller('workspace')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get()
  async aggregate(@CurrentUser() user: { userId: string }) {
    return await this.workspace.getAggregate(user.userId);
  }

  @Post('actions')
  async action(
    @CurrentUser() user: { userId: string },
    @Body() body: ActionDto,
  ) {
    return await this.workspace.runAction(user.userId, body.type, body.payload ?? {});
  }
}
