import type { SessionInfo } from '@cloudlane/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { AuditService } from './audit.service.js';

class ListAuditQuery {
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @IsInt() @Min(1) limit?: number;
}

/**
 * Audit event listing (build plan §4.6). Scoped to the owner's workspace —
 * the installation is single-workspace in Phase 1+2.
 */
@ApiTags('audit')
@Controller('audit-events')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(@Query() query: ListAuditQuery, @CurrentUser() user: SessionInfo) {
    return await this.audit.list(user.userId, {
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      cursor: query.cursor,
      limit: query.limit ?? 50,
    });
  }
}
