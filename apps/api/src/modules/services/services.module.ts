import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module.js';
import { DeploymentsModule } from '../deployments/deployments.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { ServiceDetailController, ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';

@Module({
  imports: [DeploymentsModule, UploadsModule, SecretsModule, DomainsModule],
  controllers: [ServicesController, ServiceDetailController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
