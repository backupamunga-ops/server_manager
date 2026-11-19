import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { RequireStepUp, StepUpGuard } from '../../common/guards/step-up.guard.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { SessionInfo, SessionListItem } from '@cloudlane/contracts';
import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

class MfaVerifyDto {
  @IsString()
  mfaChallengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits.' })
  code!: string;
}

class ReauthenticateDto {
  @IsOptional() @IsString() @MinLength(1) password?: string;
  @IsOptional() @IsString() @Matches(/^\d{6}$/) mfaCode?: string;
}

function getIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() || null;
  return req.ip ?? null;
}

interface RequestWithSession extends Request {
  user?: SessionInfo;
  sessionId?: string;
  csrfToken?: string;
}

function setSessionCookie(res: Response | undefined, cookieValue: string): void {
  if (!res) return;
  res.cookie('cloudlane_session', cookieValue, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true }))
  async login(@Body() body: LoginDto, @Req() req: Request) {
    return await this.auth.login(body.email, body.password, getIp(req));
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true }))
  async verifyMfa(@Body() body: MfaVerifyDto, @Req() req: RequestWithSession) {
    const result = await this.auth.verifyMfa(body.mfaChallengeId, body.code, getIp(req), req.headers['user-agent'] ?? null);
    setSessionCookie(req.res as Response | undefined, result.cookieValue);
    if (req.res) req.res.setHeader('X-CSRF-Token', result.csrfToken);
    return { userId: result.userId, sessionId: result.sessionId };
  }

  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: RequestWithSession, @CurrentUser() user: SessionInfo) {
    if (req.sessionId) {
      await this.auth.logout(req.sessionId, getIp(req), user.userId);
    }
    if (req.res) req.res.clearCookie('cloudlane_session', { path: '/' });
    return { ok: true };
  }

  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @Get('session')
  async session(@CurrentUser() user: SessionInfo): Promise<SessionInfo> {
    return user;
  }

  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @Post('reauthenticate')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true }))
  async reauthenticate(
    @Body() body: ReauthenticateDto,
    @Req() req: RequestWithSession,
    @CurrentUser() user: SessionInfo,
  ) {
    if (!req.sessionId) {
      return Promise.reject({ status: 401, response: { code: 'UNAUTHENTICATED', message: 'No session.' } });
    }
    if (body.password) {
      const expiresAt = await this.auth.reauthenticateWithPassword(user.userId, body.password, getIp(req), req.sessionId);
      return { stepUpExpiresAt: expiresAt.toISOString() };
    }
    if (body.mfaCode) {
      const expiresAt = await this.auth.reauthenticateWithMfa(user.userId, body.mfaCode, getIp(req), req.sessionId);
      return { stepUpExpiresAt: expiresAt.toISOString() };
    }
    return Promise.reject({ status: 400, response: { code: 'VALIDATION_ERROR', message: 'Provide password or mfaCode.' } });
  }

  @UseGuards(SessionGuard, StepUpGuard)
  @RequireStepUp()
  @ApiBearerAuth()
  @Post('recovery-codes/regenerate')
  @HttpCode(200)
  async regenerateRecoveryCodes(@CurrentUser() user: SessionInfo) {
    const codes = await this.auth.regenerateRecoveryCodes(user.userId);
    return { recoveryCodes: codes };
  }

  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @Get('sessions')
  async listSessions(@CurrentUser() user: SessionInfo, @Req() req: RequestWithSession): Promise<SessionListItem[]> {
    if (!req.sessionId) return [];
    const sessions = await this.sessions.listForUser(user.userId, req.sessionId);
    return sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      lastSeenAt: s.lastSeenAt.toISOString(),
      current: s.current,
    }));
  }

  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  async revokeSession(@Param('sessionId') sessionId: string, @CurrentUser() user: SessionInfo) {
    await this.sessions.revoke(sessionId);
    return { ok: true };
  }
}
