import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class GithubService {
  async getInstallUrl(state: string): Promise<{ installUrl: string; state: string }> {
    throw new NotImplementedException({
      code: 'NOT_IMPLEMENTED',
      message: 'GitHub App install URL is implemented in CL-055.',
    });
  }

  async handleCallback(
    installationId: string,
    code: string,
    state: string,
  ): Promise<{ success: true }> {
    throw new NotImplementedException({
      code: 'NOT_IMPLEMENTED',
      message: 'GitHub App callback is implemented in CL-055.',
    });
  }

  /**
   * Verify GitHub webhook HMAC SHA-256 signature.
   * This IS implemented here because it's the security boundary —
   * we want it tested and ready even before the full webhook handler lands.
   */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string, webhookSecret: string): boolean {
    if (!signatureHeader?.startsWith('sha256=')) return false;
    const expected = signatureHeader.slice('sha256='.length);

    const hmac = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    // Constant-time compare
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(hmac, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  }
}
