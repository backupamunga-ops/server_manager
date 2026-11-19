import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

/**
 * Envelope encryption service.
 *
 * Master key is loaded from env (MASTER_KEY, 32 bytes hex) at startup and held in memory only.
 * Per-row encryption uses AES-256-GCM with a random 12-byte IV per encryption.
 *
 * Ciphertext format: base64(iv || ciphertext || authTag)
 *
 * The master key NEVER enters PostgreSQL. If the key is rotated, old values
 * remain encrypted with the old key; a migration tool re-encrypts them.
 * This is intentionally simple — for production at scale, consider a KMS.
 */
@Injectable()
export class SecretsService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.get<string>('MASTER_KEY');
    if (!hex) {
      throw new Error('MASTER_KEY env var is required. Generate with: openssl rand -hex 32');
    }
    const key = Buffer.from(hex, 'hex');
    if (key.length !== KEY_LEN) {
      throw new Error(
        `MASTER_KEY must be ${KEY_LEN} bytes (64 hex chars). Got ${key.length} bytes.`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]).toString('base64');
  }

  decrypt(envelope: string): string {
    const buf = Buffer.from(envelope, 'base64');
    if (buf.length < IV_LEN + 16) {
      throw new Error('Ciphertext too short');
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(IV_LEN, buf.length - 16);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
