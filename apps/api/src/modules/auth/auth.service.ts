import { randomBytes } from 'node:crypto';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import type { PrismaService } from '../../common/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { MfaService } from './mfa.service.js';
import type { PasswordService } from './password.service.js';
import type { SessionService } from './session.service.js';
import { addMinutes } from './time-utils.js';

class TooManyRequestsException extends HttpException {
  constructor(body: object) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

interface PendingLogin {
  challengeId: string;
  userId: string;
  expiresAt: Date;
  attemptCount: number;
}

const pendingLogins = new Map<string, PendingLogin>();
const loginRateLimit = new Map<string, { count: number; windowStart: number }>();

@Injectable()
export class AuthService {
  private readonly loginRateLimitPerMinute: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    config: ConfigService,
  ) {
    this.loginRateLimitPerMinute = config.get<number>('LOGIN_RATE_LIMIT_PER_MINUTE', 10);
  }

  /**
   * Step 1 of login: verify password, return MFA challenge.
   * Same error for missing user and bad password (enumeration resistance).
   */
  async login(
    email: string,
    password: string,
    ip: string | null,
  ): Promise<{ requiresMfa: true; mfaChallengeId: string }> {
    this.checkRateLimit(ip, 'login');

    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { password: true },
    });

    // Constant-ish-time: even if user not found, do a dummy hash verify
    const dummyHash =
      '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const passwordOk = user?.password
      ? await this.passwords.verify(user.password.argon2Hash, password)
      : await this.passwords.verify(dummyHash, password);

    if (!user || !user.isActive || !passwordOk) {
      await this.audit.record('LOGIN_FAILED', 'denied', {
        actorType: 'system',
        ipAddress: ip,
        resourceType: 'user',
        resourceId: user?.id ?? null,
        metadata: { reason: user ? 'bad_password' : 'unknown_email' },
      });
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    // Issue MFA challenge
    const challengeId = randomBytes(16).toString('base64url');
    pendingLogins.set(challengeId, {
      challengeId,
      userId: user.id,
      expiresAt: addMinutes(new Date(), 2),
      attemptCount: 0,
    });

    return { requiresMfa: true, mfaChallengeId: challengeId };
  }

  /** Step 2 of login: verify MFA code, issue session. */
  async verifyMfa(
    challengeId: string,
    code: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ cookieValue: string; sessionId: string; csrfToken: string; userId: string }> {
    const pending = pendingLogins.get(challengeId);
    if (!pending || pending.expiresAt < new Date()) {
      pendingLogins.delete(challengeId);
      throw new UnauthorizedException({
        code: 'MFA_CHALLENGE_EXPIRED',
        message: 'MFA challenge expired. Restart login.',
      });
    }

    pending.attemptCount++;
    if (pending.attemptCount > 5) {
      pendingLogins.delete(challengeId);
      throw new TooManyRequestsException({
        code: 'MFA_MAX_ATTEMPTS',
        message: 'Too many MFA attempts.',
      });
    }

    // Try TOTP first
    const codeValid = await this.mfa.verify(pending.userId, code);
    // Then recovery code
    const recoveryValid = codeValid
      ? false
      : await this.mfa.verifyRecoveryCode(pending.userId, code);

    if (!codeValid && !recoveryValid) {
      await this.audit.record('MFA_VERIFIED', 'denied', {
        actorType: 'system',
        actorUserId: pending.userId,
        ipAddress: ip,
      });
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'Incorrect MFA code.' });
    }

    if (recoveryValid) {
      await this.audit.record('RECOVERY_CODE_USED', 'success', {
        actorType: 'system',
        actorUserId: pending.userId,
        ipAddress: ip,
      });
    }

    pendingLogins.delete(challengeId);

    const session = await this.sessions.create(pending.userId, ip, userAgent);

    await this.prisma.user.update({
      where: { id: pending.userId },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record('LOGIN_SUCCESS', 'success', {
      actorType: 'system',
      actorUserId: pending.userId,
      ipAddress: ip,
    });

    return {
      cookieValue: session.cookieValue,
      sessionId: session.sessionId,
      csrfToken: session.csrfToken,
      userId: pending.userId,
    };
  }

  async logout(sessionId: string, ip: string | null, userId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.audit.record('LOGOUT', 'success', {
      actorType: 'user',
      actorUserId: userId,
      ipAddress: ip,
      resourceType: 'session',
      resourceId: sessionId,
    });
  }

  async reauthenticateWithPassword(
    userId: string,
    password: string,
    ip: string | null,
    sessionId: string,
  ): Promise<Date> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { password: true },
    });
    if (!user?.password) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials.',
      });
    }
    const ok = await this.passwords.verify(user.password.argon2Hash, password);
    if (!ok) {
      await this.audit.record('LOGIN_FAILED', 'denied', {
        actorType: 'user',
        actorUserId: userId,
        ipAddress: ip,
        metadata: { reason: 'reauth_bad_password' },
      });
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials.',
      });
    }
    const expiresAt = await this.sessions.grantStepUp(sessionId);
    return expiresAt;
  }

  async reauthenticateWithMfa(
    userId: string,
    code: string,
    ip: string | null,
    sessionId: string,
  ): Promise<Date> {
    const ok = await this.mfa.verify(userId, code);
    if (!ok) {
      await this.audit.record('MFA_VERIFIED', 'denied', {
        actorType: 'user',
        actorUserId: userId,
        ipAddress: ip,
      });
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'Incorrect MFA code.' });
    }
    const expiresAt = await this.sessions.grantStepUp(sessionId);
    return expiresAt;
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = this.mfa.generateRecoveryCodes(10);
    await this.mfa.storeRecoveryCodes(userId, codes);
    return codes;
  }

  private checkRateLimit(ip: string | null, bucket: string): void {
    if (!ip) return;
    const key = `${bucket}:${ip}`;
    const now = Date.now();
    const entry = loginRateLimit.get(key);
    if (!entry || now - entry.windowStart > 60_000) {
      loginRateLimit.set(key, { count: 1, windowStart: now });
      return;
    }
    entry.count++;
    if (entry.count > this.loginRateLimitPerMinute) {
      throw new TooManyRequestsException({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Try again in a minute.',
      });
    }
  }
}
