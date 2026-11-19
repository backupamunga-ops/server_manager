import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { addMinutes } from './time-utils.js';

const SESSION_BYTES = 32;
const CSRF_BYTES = 24;

/**
 * Session service — opaque server-stored sessions.
 *
 * Cookie value = base64url(randomBytes(SESSION_BYTES) || '.' || sessionId)
 * We hash the random part for storage lookup. The sessionId is included in the
 * cookie only so the dashboard can identify "current" session in the list view;
 * it cannot be used to authenticate without the random handle.
 */
@Injectable()
export class SessionService {
  private readonly cookieName: string;
  private readonly ttlMinutes: number;
  private readonly stepUpTtlMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    config: ConfigService,
  ) {
    this.cookieName = config.get<string>('SESSION_COOKIE_NAME', 'cloudlane_session');
    this.ttlMinutes = config.get<number>('SESSION_TTL_MINUTES', 10080);
    this.stepUpTtlMinutes = config.get<number>('SESSION_STEPUP_TTL_MINUTES', 5);
  }

  getCookieName(): string {
    return this.cookieName;
  }

  /** Create a new session for a user. Returns the cookie value and the DB record. */
  async create(
    userId: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ cookieValue: string; sessionId: string; csrfToken: string }> {
    const handle = randomBytes(SESSION_BYTES);
    const handleHash = this.hashHandle(handle);
    const csrfToken = randomBytes(CSRF_BYTES).toString('base64url');
    const now = new Date();
    const expiresAt = addMinutes(now, this.ttlMinutes);

    const session = await this.prisma.session.create({
      data: {
        userId,
        handleHash,
        csrfToken,
        expiresAt,
        ip,
        userAgent,
        requiresStepUp: false,
      },
    });

    const cookieValue = `${handle.toString('base64url')}.${session.id}`;
    return { cookieValue, sessionId: session.id, csrfToken };
  }

  /** Validate a cookie value. Returns the session record if valid, else null. */
  async validate(cookieValue: string | undefined): Promise<{
    sessionId: string;
    userId: string;
    csrfToken: string;
    requiresStepUp: boolean;
    stepUpExpiresAt: Date | null;
  } | null> {
    if (!cookieValue) return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 2) return null;
    const handle = parts[0];
    const sessionId = parts[1];
    let handleBuf: Buffer;
    try {
      handleBuf = Buffer.from(handle, 'base64url');
    } catch {
      return null;
    }
    if (handleBuf.length !== SESSION_BYTES) return null;
    const handleHash = this.hashHandle(handleBuf);

    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        handleHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) return null;

    // Touch lastSeenAt
    await this.prisma.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => {});

    return {
      sessionId: session.id,
      userId: session.userId,
      csrfToken: session.csrfToken,
      requiresStepUp: session.requiresStepUp,
      stepUpExpiresAt: session.stepUpExpiresAt,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: {
        userId,
        id: exceptSessionId ? { not: exceptSessionId } : undefined,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
  }

  async listForUser(
    userId: string,
    currentSessionId: string,
  ): Promise<
    Array<{
      id: string;
      ip: string | null;
      userAgent: string | null;
      lastSeenAt: Date;
      current: boolean;
    }>
  > {
    const sessions = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      lastSeenAt: s.lastSeenAt,
      current: s.id === currentSessionId,
    }));
  }

  async grantStepUp(sessionId: string): Promise<Date> {
    const expiresAt = addMinutes(new Date(), this.stepUpTtlMinutes);
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { requiresStepUp: true, stepUpExpiresAt: expiresAt },
    });
    return expiresAt;
  }

  /** Rotate session identity (on login, privilege change, password change). */
  async rotate(
    oldSessionId: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ cookieValue: string; sessionId: string; csrfToken: string }> {
    const old = await this.prisma.session.findUnique({ where: { id: oldSessionId } });
    if (!old) throw new Error('Session not found during rotation');
    const created = await this.create(old.userId, ip, userAgent);
    await this.revoke(oldSessionId);
    return created;
  }

  private hashHandle(handle: Buffer): string {
    return createHash('sha256').update(handle).digest('hex');
  }
}
