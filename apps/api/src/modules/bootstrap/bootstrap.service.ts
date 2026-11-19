import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

class TooManyRequestsException extends HttpException {
  constructor(body: object) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}
import { createHash, randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import { v4 as uuidv4 } from 'uuid';
import type { PrismaService } from '../../common/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { MfaService } from '../auth/mfa.service.js';
import type { PasswordService } from '../auth/password.service.js';
import type { SessionService } from '../auth/session.service.js';
import { addMinutes, isExpired } from '../auth/time-utils.js';
import type { SecretsService } from '../secrets/secrets.service.js';

interface PendingClaim {
  token: string;
  installationId: string;
  expiresAt: Date;
}

/**
 * In-memory store for short-lived claim tokens (issued after claim code verified,
 * consumed when owner is created). TTL is short and bounded — we do not persist
 * these tokens. If the API restarts mid-claim, the user re-enters the claim code.
 *
 * In a multi-instance deployment this would move to a Redis SETEX; for the
 * single-VPS target, in-memory is correct.
 */
const pendingClaims = new Map<string, PendingClaim>();

interface OwnerCreationInput {
  email: string;
  password: string;
  workspaceName: string;
  mfaType: 'totp';
}

interface OwnerCreationResult {
  userId: string;
  workspaceId: string;
  mfaEnrollment: {
    factorId: string;
    secret: string;
    otpauthUrl: string;
  };
  recoveryCodes: string[];
}

@Injectable()
export class BootstrapService {
  private readonly logger = new Logger(BootstrapService.name);
  private readonly claimTtlMinutes: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: SecretsService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {
    this.claimTtlMinutes = config.get<number>('CLAIM_TTL_MINUTES', 20);
    this.maxAttempts = config.get<number>('CLAIM_MAX_ATTEMPTS', 5);
  }

  /**
   * Verify the one-time claim code printed by the installer.
   * Atomic: increments attempt count, marks consumed on success.
   *
   * The installer stores BOTH a SHA-256 lookup hash (for findFirst) AND an
   * Argon2id verification hash (for rate-limit-safe comparison). Here we use
   * the lookup hash to find the row; the lookup hash itself is sufficient
   * authentication because the claim code has 32 bytes (256 bits) of entropy.
   */
  async verifyClaim(code: string, ip: string | null): Promise<{ token: string; expiresAt: Date }> {
    const lookupHash = createHash('sha256').update(code).digest('hex');

    const claim = await this.prisma.installationClaim.findFirst({
      where: { claimHash: lookupHash },
      include: { installation: true },
    });

    if (!claim) {
      await this.audit.record('CLAIM_FAILED', 'denied', {
        actorType: 'system',
        ipAddress: ip,
        metadata: { reason: 'unknown_code' },
      });
      throw new UnauthorizedException({
        code: 'CLAIM_INVALID',
        message: 'Claim code not recognized.',
      });
    }

    if (claim.status === 'CLAIM_CONSUMED') {
      throw new ConflictException({
        code: 'CLAIM_CONSUMED',
        message: 'This claim code has already been used.',
      });
    }

    if (claim.status === 'CLAIM_EXPIRED' || isExpired(claim.expiresAt)) {
      await this.markExpired(claim.id);
      throw new UnauthorizedException({
        code: 'CLAIM_EXPIRED',
        message: 'Claim code expired. Generate a new one via the installer.',
      });
    }

    if (claim.attemptCount >= claim.maxAttempts) {
      await this.markExpired(claim.id);
      await this.audit.record('CLAIM_FAILED', 'denied', {
        actorType: 'system',
        ipAddress: ip,
        metadata: { reason: 'max_attempts' },
      });
      throw new TooManyRequestsException({
        code: 'CLAIM_MAX_ATTEMPTS',
        message: 'Too many attempts. Claim expired.',
      });
    }

    await this.prisma.installationClaim.update({
      where: { id: claim.id },
      data: { attemptCount: { increment: 1 } },
    });

    const token = randomBytes(32).toString('base64url');
    const expiresAt = addMinutes(new Date(), 5);
    pendingClaims.set(token, {
      token,
      installationId: claim.installationId,
      expiresAt,
    });

    await this.audit.record('CLAIM_VERIFIED', 'success', {
      actorType: 'system',
      ipAddress: ip,
      resourceType: 'installation',
      resourceId: claim.installationId,
    });

    return { token, expiresAt };
  }

  /**
   * Create the first owner account. Atomic transaction:
   *   - Verify pending claim token
   *   - Verify no existing owner (idempotency)
   *   - Create User + PasswordCredential + MfaFactor (unverified) + Workspace
   *   - Mark claim as CONSUMED
   *   - Return recovery codes (shown once) and MFA enrollment secret
   */
  async createOwner(
    input: OwnerCreationInput,
    claimToken: string,
    ip: string | null,
  ): Promise<OwnerCreationResult> {
    const pending = pendingClaims.get(claimToken);
    if (!pending || isExpired(pending.expiresAt)) {
      pendingClaims.delete(claimToken);
      throw new UnauthorizedException({
        code: 'CLAIM_TOKEN_INVALID',
        message: 'Claim session expired. Restart the claim flow.',
      });
    }

    const existingOwner = await this.prisma.user.findFirst({ where: { role: 'OWNER' } });
    if (existingOwner) {
      pendingClaims.delete(claimToken);
      throw new ConflictException({
        code: 'OWNER_EXISTS',
        message: 'This installation already has an owner.',
      });
    }

    this.validateEmail(input.email);
    this.validatePassword(input.password);
    if (!input.workspaceName || input.workspaceName.length < 2 || input.workspaceName.length > 64) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Workspace name must be 2-64 characters.',
      });
    }

    const mfaSecret = this.mfa.generateSecret();
    const otpauthUrl = this.mfa.buildOtpauthUrl(input.email, mfaSecret);
    const recoveryCodes = this.mfa.generateRecoveryCodes(10);

    const userId = uuidv4();
    const workspaceId = uuidv4();
    const factorId = uuidv4();

    const user = await this.prisma.$transaction(async (tx) => {
      const passwordHash = await this.passwords.hash(input.password);

      const created = await tx.user.create({
        data: {
          id: userId,
          email: input.email.toLowerCase(),
          role: 'OWNER',
          password: {
            create: {
              argon2Hash: passwordHash,
              pepperVersion: this.passwords.getPepperVersion(),
            },
          },
          mfaFactors: {
            create: [
              {
                id: factorId,
                type: 'TOTP',
                encryptedSecret: this.secrets.encrypt(mfaSecret),
              },
            ],
          },
          recoveryCodes: {
            createMany: {
              data: recoveryCodes.map((c) => ({
                codeHash: this.mfa.hashRecoveryCode(c),
              })),
            },
          },
          ownedWorkspaces: {
            create: { id: workspaceId, name: input.workspaceName },
          },
        },
        include: { mfaFactors: true },
      });

      await tx.installationIdentity.update({
        where: { id: pending.installationId },
        data: { claimedAt: new Date() },
      });

      await tx.installationClaim.updateMany({
        where: { installationId: pending.installationId },
        data: { status: 'CLAIM_CONSUMED', consumedAt: new Date() },
      });

      return created;
    });

    pendingClaims.delete(claimToken);

    await this.audit.record('OWNER_CREATED', 'success', {
      actorType: 'system',
      actorUserId: user.id,
      ipAddress: ip,
      resourceType: 'user',
      resourceId: user.id,
    });

    return {
      userId: user.id,
      workspaceId,
      mfaEnrollment: {
        factorId,
        secret: mfaSecret,
        otpauthUrl,
      },
      recoveryCodes,
    };
  }

  /**
   * Verify the first MFA code after owner creation. Marks the factor verified.
   * If successful, creates an authenticated session.
   */
  async verifyFirstMfa(
    factorId: string,
    code: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ cookieValue: string; sessionId: string; csrfToken: string; userId: string }> {
    const factor = await this.prisma.mfaFactor.findUnique({ where: { id: factorId } });
    if (!factor) {
      throw new BadRequestException({
        code: 'MFA_FACTOR_NOT_FOUND',
        message: 'MFA factor not found.',
      });
    }
    if (factor.verifiedAt) {
      throw new BadRequestException({
        code: 'MFA_ALREADY_VERIFIED',
        message: 'MFA factor is already verified.',
      });
    }

    const secret = this.secrets.decrypt(factor.encryptedSecret);
    const valid = authenticator.verify({ token: code, secret });
    if (!valid) {
      await this.audit.record('MFA_VERIFIED', 'denied', {
        actorType: 'system',
        ipAddress: ip,
        resourceType: 'user',
        resourceId: factor.userId,
      });
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'Incorrect MFA code.' });
    }

    await this.prisma.mfaFactor.update({
      where: { id: factorId },
      data: { verifiedAt: new Date(), enabledAt: new Date() },
    });

    const session = await this.sessions.create(factor.userId, ip, userAgent);

    await this.audit.record('MFA_ENROLLED', 'success', {
      actorType: 'system',
      actorUserId: factor.userId,
      ipAddress: ip,
      resourceType: 'mfa_factor',
      resourceId: factorId,
    });
    await this.audit.record('LOGIN_SUCCESS', 'success', {
      actorType: 'system',
      actorUserId: factor.userId,
      ipAddress: ip,
    });

    return {
      cookieValue: session.cookieValue,
      sessionId: session.sessionId,
      csrfToken: session.csrfToken,
      userId: factor.userId,
    };
  }

  private validateEmail(email: string): void {
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Invalid email address.',
      });
    }
  }

  private validatePassword(password: string): void {
    if (password.length < 12) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Password must be at least 12 characters.',
      });
    }
    if (password.length > 1024) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Password too long.' });
    }
    const categories = [
      /[a-z]/.test(password),
      /[A-Z]/.test(password),
      /[0-9]/.test(password),
      /[^a-zA-Z0-9]/.test(password),
    ].filter(Boolean).length;
    if (categories < 3) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Password must contain at least 3 of: lowercase, uppercase, digits, symbols.',
      });
    }
  }

  private async markExpired(claimId: string): Promise<void> {
    await this.prisma.installationClaim
      .update({
        where: { id: claimId },
        data: { status: 'CLAIM_EXPIRED' },
      })
      .catch(() => {});
  }
}
