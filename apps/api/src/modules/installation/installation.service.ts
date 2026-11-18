import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

interface InstallationState {
  status: 'unclaimed' | 'claimed' | 'active';
  version: string;
  instanceId: string;
}

@Injectable()
export class InstallationService {
  private readonly logger = new Logger(InstallationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Get the public-safe installation status.
   * On first run, if no installation record exists, create one.
   */
  async getStatus(): Promise<InstallationState> {
    let identity = await this.prisma.installationIdentity.findFirst();
    if (!identity) {
      identity = await this.bootstrapIdentity();
    }

    const claimed = await this.prisma.user.findFirst({ where: { role: 'OWNER' } });
    const status: InstallationState['status'] = claimed ? 'active' : 'unclaimed';

    return {
      status,
      version: identity.version,
      instanceId: identity.instanceId,
    };
  }

  async getIdentity(): Promise<{ id: string; instanceId: string; version: string }> {
    let identity = await this.prisma.installationIdentity.findFirst();
    if (!identity) {
      identity = await this.bootstrapIdentity();
    }
    return { id: identity.id, instanceId: identity.instanceId, version: identity.version };
  }

  /**
   * Create the installation identity on first run.
   * This happens on API startup if the table is empty — typically the
   * installer creates it before the API starts, but we handle the dev case.
   */
  private async bootstrapIdentity() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const encryptedSecret = this.secrets.encrypt(privateKeyPem);
    const instanceId = `inst_${randomBytes(12).toString('base64url')}`;
    const version = this.config.get<string>('INSTALLER_VERSION', '0.1.0-dev');

    this.logger.log(`Bootstrapping new installation: instanceId=${instanceId}`);
    return await this.prisma.installationIdentity.create({
      data: {
        instanceId,
        version,
        publicKey: publicKeyPem,
        encryptedSecret,
      },
    });
  }
}
