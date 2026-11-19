import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma.service.js';
import { Public } from '../../common/decorators/public.decorator.js';

/**
 * Caddy on-demand TLS decision endpoint (global `on_demand_tls.ask`).
 * Lives under /caddy/ask — /domains/:domainId param routes would capture
 * /domains/ondemand-ask (controller registration order), so avoid the collision.
 * Caddy calls it before issuing a certificate for an unknown hostname.
 * Only hostnames registered in the Cloudlane registry may get a certificate:
 * attached custom domains, registry hostnames, and platform-generated
 * <slug>.apps.<suffix> URLs. Everything else is refused (403).
 */
@ApiTags('domains')
@Controller('caddy')
export class OnDemandAskController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('ask')
  async ask(@Query('domain') domain?: string, @Query('host') hostParam?: string) {
    const raw = String(domain ?? hostParam ?? '').toLowerCase().trim().replace(/\.$/, '');
    if (!raw || raw.length > 253 || /[^a-z0-9.\-]/.test(raw)) {
      throw new BadRequestException('Bad hostname.');
    }
    const [domainRow, hostnameRow] = await Promise.all([
      this.prisma.domain.findFirst({ where: { host: raw } }),
      this.prisma.hostname.findFirst({ where: { name: raw } }),
    ]);
    if (!domainRow && !hostnameRow) {
      throw new BadRequestException('Hostname is not registered in Cloudlane.');
    }
    return { ok: true, host: raw };
  }
}
