import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from './session.guard.js';

export const STEP_UP_KEY = 'requiresStepUp';

export const RequireStepUp = (): MethodDecorator =>
  Reflect.metadata(STEP_UP_KEY, true) as unknown as MethodDecorator;

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) return false;

    const now = Date.now();
    const expiresAt = req.user.stepUpExpiresAt ? Date.parse(req.user.stepUpExpiresAt) : Number.NaN;
    if (!expiresAt || expiresAt < now) {
      throw new ForbiddenException({
        code: 'STEP_UP_REQUIRED',
        message: 'Reauthentication required for this action.',
      });
    }
    return true;
  }
}
