import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { authenticator } from 'otplib';
import { randomBytes, createHmac } from 'node:crypto';

@Injectable()
export class MfaService {
  private readonly window = 1;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    config: ConfigService,
  ) {
    const issuer = config.get<string>('INSTANCE_ID', 'cloudlane');
    authenticator.options = { window: this.window, step: 30, issuer: issuer };
  }

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  buildOtpauthUrl(email: string, secret: string): string {
    return authenticator.keyuri(email, 'cloudlane', secret);
  }

  async verify(userId: string, code: string): Promise<boolean> {
    const factor = await this.prisma.mfaFactor.findFirst({
      where: { userId, type: 'TOTP', verifiedAt: { not: null } },
    });
    if (!factor) return false;
    const secret = this.secrets.decrypt(factor.encryptedSecret);
    return authenticator.verify({ token: code, secret });
  }

  async enroll(userId: string, secret: string): Promise<string> {
    const encrypted = this.secrets.encrypt(secret);
    const factor = await this.prisma.mfaFactor.create({
      data: { userId, type: 'TOTP', encryptedSecret: encrypted },
    });
    return factor.id;
  }

  async markVerified(factorId: string): Promise<void> {
    await this.prisma.mfaFactor.update({
      where: { id: factorId },
      data: { verifiedAt: new Date(), enabledAt: new Date() },
    });
  }

  generateRecoveryCodes(count = 10): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const bytes = randomBytes(6);
      const hex = bytes.toString('hex').toUpperCase();
      codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`);
    }
    return codes;
  }

  hashRecoveryCode(code: string): string {
    const key = process.env.MASTER_KEY || 'fallback';
    return createHmac('sha256', key).update(code).digest('hex');
  }

  async storeRecoveryCodes(userId: string, codes: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.recoveryCodeHash.deleteMany({ where: { userId } }),
      this.prisma.recoveryCodeHash.createMany({
        data: codes.map((c) => ({ userId, codeHash: this.hashRecoveryCode(c) })),
      }),
    ]);
  }

  async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = this.hashRecoveryCode(code);
    const record = await this.prisma.recoveryCodeHash.findFirst({
      where: { userId, codeHash: hash, usedAt: null },
    });
    if (!record) return false;
    await this.prisma.recoveryCodeHash.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    return true;
  }
}
