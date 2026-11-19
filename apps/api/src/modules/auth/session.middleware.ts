import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { SessionService } from './session.service.js';
import { PrismaService } from '../../common/prisma.service.js';
import type { Request, Response, NextFunction } from 'express';
import type { SessionInfo } from '@cloudlane/contracts';

interface RequestWithSession extends Request {
  user?: SessionInfo;
  sessionId?: string;
  csrfToken?: string;
}

/**
 * Session middleware — runs on every request.
 *
 * Validates the session cookie if present and attaches req.user with the
 * SessionInfo shape. Does NOT reject unauthenticated requests — that is the
 * SessionGuard's job (with @Public() decorator to allow specific routes).
 *
 * Also implements CSRF protection via double-submit token: state-changing
 * requests must include X-CSRF-Token header matching the session's csrfToken.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: RequestWithSession, res: Response, next: NextFunction): Promise<void> {
    const cookieName = this.sessions.getCookieName();
    const cookieValue = (req.cookies as Record<string, string> | undefined)?.[cookieName];

    const session = await this.sessions.validate(cookieValue);
    if (session) {
      const user = await this.prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, email: true, role: true, isActive: true },
      });
      if (user?.isActive) {
        const stepUpExpiresAt = session.stepUpExpiresAt;
        const requiresStepUp = session.requiresStepUp &&
          stepUpExpiresAt !== null &&
          stepUpExpiresAt.getTime() > Date.now();
        req.user = {
          userId: session.userId,
          email: user.email,
          role: 'OWNER',
          requiresStepUp,
          stepUpExpiresAt: stepUpExpiresAt ? stepUpExpiresAt.toISOString() : null,
        };
        req.sessionId = session.sessionId;
        req.csrfToken = session.csrfToken;
      }
    }

    // CSRF check for state-changing requests (double-submit token)
    const method = req.method.toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const path = req.path;
      const isPublicMutation =
        path.endsWith('/bootstrap/claim') ||
        path.endsWith('/bootstrap/owner') ||
        path.endsWith('/bootstrap/mfa/verify') ||
        path.endsWith('/auth/login') ||
        path.endsWith('/auth/mfa/verify') ||
        path.endsWith('/auth/reauthenticate') ||
        path.endsWith('/installation/status') ||
        path.startsWith('/api/v1/github/webhook') ||
        path.startsWith('/api/v1/uploads/') && path.endsWith('/finalize') && !req.user;

      if (!isPublicMutation && req.user) {
        const headerToken = (req.headers['x-csrf-token'] as string) || '';
        if (!headerToken || !session || headerToken !== session.csrfToken) {
          throw new UnauthorizedException({
            code: 'CSRF_TOKEN_INVALID',
            message: 'CSRF token missing or invalid.',
          });
        }
      }
    }

    next();
  }
}
