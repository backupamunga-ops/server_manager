import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

/**
 * Password hashing service using Argon2id.
 *
 * Parameters tuned for starter VPS (1 vCPU): the goal is to be slow enough
 * to defeat offline brute-force but not so slow that login takes >2s.
 *
 * The pepper is added to the plaintext before hashing and is rotated via
 * PEPPER_VERSION env var. On rotation, a migration tool re-hashes passwords
 * on next login.
 */
@Injectable()
export class PasswordService {
  private readonly pepper: string;
  private readonly pepperVersion: number;
  private readonly params: argon2.Options;

  constructor(config: ConfigService) {
    this.pepper = config.get<string>('PASSWORD_PEPPER', '');
    this.pepperVersion = config.get<number>('PEPPER_VERSION', 1);
    this.params = {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 1,
    };
  }

  async hash(plaintext: string): Promise<string> {
    const salted = this.applyPepper(plaintext);
    return argon2.hash(salted, this.params);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      const salted = this.applyPepper(plaintext);
      return await argon2.verify(hash, salted);
    } catch {
      return false;
    }
  }

  /** Generate a random password reset token (URL-safe, 32 bytes). */
  generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  getPepperVersion(): number {
    return this.pepperVersion;
  }

  private applyPepper(plaintext: string): string {
    if (!this.pepper) return plaintext;
    return `${plaintext}:${this.pepper}`;
  }
}
