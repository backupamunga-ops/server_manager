import { Body, Controller, Headers, HttpCode, Post, Req, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { BootstrapService } from './bootstrap.service.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { IsEnum, IsString, MinLength, MaxLength, Matches } from 'class-validator';

class ClaimDto {
  @IsString()
  @Matches(/^[A-Z2-7]{16,}$/, { message: 'claimCode must be base32.' })
  claimCode!: string;
}

class OwnerDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, { message: 'Invalid email.' })
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(1024)
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  workspaceName!: string;

  @IsEnum(['totp'])
  mfaType!: 'totp';
}

class MfaVerifyDto {
  @IsString()
  factorId!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits.' })
  code!: string;
}

function getIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() || null;
  return req.ip ?? null;
}

@ApiTags('bootstrap')
@Controller('bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Public()
  @Post('claim')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true }))
  async claim(@Body() body: ClaimDto, @Req() req: Request): Promise<{ token: string; expiresAt: string }> {
    const result = await this.bootstrap.verifyClaim(body.claimCode, getIp(req));
    return { token: result.token, expiresAt: result.expiresAt.toISOString() };
  }

  @Public()
  @Post('owner')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true }))
  async createOwner(
    @Body() body: OwnerDto,
    @Headers('x-claim-token') claimToken: string,
    @Req() req: Request,
  ) {
    if (!claimToken) {
      return Promise.reject({
        status: 401,
        response: { code: 'CLAIM_TOKEN_MISSING', message: 'X-Claim-Token header required.' },
      });
    }
    const result = await this.bootstrap.createOwner(
      { email: body.email, password: body.password, workspaceName: body.workspaceName, mfaType: body.mfaType },
      claimToken,
      getIp(req),
    );
    return result;
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true }))
  async verifyMfa(@Body() body: MfaVerifyDto, @Req() req: Request) {
    const result = await this.bootstrap.verifyFirstMfa(body.factorId, body.code, getIp(req), req.headers['user-agent'] ?? null);
    // Set the session cookie
    const res = (req as Request & { res?: import('express').Response }).res;
    if (res) {
      res.cookie('cloudlane_session', result.cookieValue, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.setHeader('X-CSRF-Token', result.csrfToken);
    }
    return { userId: result.userId, sessionId: result.sessionId };
  }
}
