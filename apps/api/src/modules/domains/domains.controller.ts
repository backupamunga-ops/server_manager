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
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { DomainsService } from './domains.service.js';

class AddDomainDto {
  @IsString()
  @MinLength(4)
  @MaxLength(253)
  host!: string;
}

class DnsModeDto {
  @IsIn(['MANUAL', 'MANAGED'])
  mode!: 'MANUAL' | 'MANAGED';
}

/**
 * Domains (master guide §06): one-field Add Domain, verification via a
 * TXT challenge record, DNS mode changes only under Settings.
 */
@ApiTags('domains')
@Controller('domains')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  async list(@CurrentUser() user: SessionInfo) {
    return await this.domains.list(user.userId);
  }

  @UsePipes(new ValidationPipe({ transform: true }))
  @Post()
  async add(@Body() body: AddDomainDto, @CurrentUser() user: SessionInfo) {
    return await this.domains.add(user.userId, body.host);
  }

  @Get(':domainId')
  async get(@Param('domainId') domainId: string, @CurrentUser() user: SessionInfo) {
    return await this.domains.get(user.userId, domainId);
  }

  @Post(':domainId/verify')
  async verify(@Param('domainId') domainId: string, @CurrentUser() user: SessionInfo) {
    return await this.domains.verify(user.userId, domainId);
  }

  @UsePipes(new ValidationPipe({ transform: true }))
  @Post(':domainId/dns-mode')
  async setDnsMode(
    @Param('domainId') domainId: string,
    @Body() body: DnsModeDto,
    @CurrentUser() user: SessionInfo,
  ) {
    return await this.domains.setDnsMode(user.userId, domainId, body.mode);
  }

  @Delete(':domainId')
  async remove(@Param('domainId') domainId: string, @CurrentUser() user: SessionInfo) {
    return await this.domains.remove(user.userId, domainId);
  }
}
