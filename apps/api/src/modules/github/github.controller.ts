import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { GithubService } from './github.service.js';

@ApiTags('github')
@Controller('github')
export class GithubController {
  constructor(
    private readonly github: GithubService,
    private readonly config: ConfigService,
  ) {}

  @Get('app/install-url')
  async installUrl() {
    // State is a CSRF token; full implementation in CL-055
    const state = randomUUID();
    return this.github.getInstallUrl(state);
  }

  @Public()
  @Get('app/callback')
  async callback(
    @Query('installation_id') installationId: string,
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    await this.github.handleCallback(installationId, code, state);
    return { success: true as const };
  }

  @Public()
  @Post('webhook')
  async webhook(
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') event: string,
    @Headers('x-github-delivery') deliveryId: string,
    @Req() req: Request,
  ) {
    const secret = this.config.get<string>('GITHUB_APP_WEBHOOK_SECRET', '');
    if (!secret) {
      return { status: 'rejected', reason: 'webhook_secret_not_configured' };
    }
    // rawBody is available because we set rawBody: true in NestFactory.create()
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      return { status: 'rejected', reason: 'missing_raw_body' };
    }
    const ok = this.github.verifyWebhookSignature(rawBody, signature, secret);
    if (!ok) {
      return { status: 'rejected', reason: 'signature_invalid' };
    }
    // Full event handling implemented in CL-055
    return { status: 'accepted', event, deliveryId };
  }
}
