import type { SessionInfo } from '@cloudlane/contracts';
import { Injectable, type NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { PrismaService } from '../../common/prisma.service.js';

interface RequestWithSession extends Request {
  user?: SessionInfo;
  sessionId?: string;
  csrfToken?: string;
}

@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: RequestWithSession, res: Response, next: NextFunction): Promise<void> {
    const cookieName = 'cloudlane_session';
    const cookieValue = (req.cookies as Record<string, string> | undefined)?.[cookieName];

    if (cookieValue) {
      const parts = cookieValue.split('.');
      if (parts.length === 2) {
        const handle = parts[0];
        const sessionId = parts[1];
        let handleBuf: Buffer;
        try {
          handleBuf = Buffer.from(handle, 'base64url');
        } catch {
          handleBuf = Buffer.alloc(0);
        }
        if (handleBuf.length === 32) {
          const crypto = require('node:crypto');
          const handleHash = crypto.createHash('sha256').update(handleBuf).digest('hex');
          const session = await this.prisma.session.findFirst({
            where: { id: sessionId, handleHash, revokedAt: null, expiresAt: { gt: new Date() } },
          });
          if (session) {
            const user = await this.prisma.user.findUnique({
              where: { id: session.userId },
              select: { id: true, email: true, role: true, isActive: true },
            });
            if (user?.isActive) {
              const stepUpExpiresAt = session.stepUpExpiresAt;
              const requiresStepUp =
                session.requiresStepUp &&
                stepUpExpiresAt !== null &&
                stepUpExpiresAt.getTime() > Date.now();
              req.user = {
                userId: session.userId,
                email: user.email,
                role: 'OWNER',
                requiresStepUp,
                stepUpExpiresAt: stepUpExpiresAt ? stepUpExpiresAt.toISOString() : null,
              };
              req.sessionId = session.id;
              req.csrfToken = session.csrfToken;
              res.setHeader('X-CSRF-Token', session.csrfToken);
            }
          }
        }
      }
    }

    // CSRF check DISABLED for HTTP dev mode
    // Will re-enable when HTTPS is configured

    next();
  }
}
