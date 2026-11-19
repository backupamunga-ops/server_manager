import { Module } from '@nestjs/common';
import { DomainsController } from './domains.controller.js';
import { OnDemandAskController } from './ondemand-ask.controller.js';
import { DomainsService } from './domains.service.js';

@Module({
  controllers: [DomainsController, OnDemandAskController],
  providers: [DomainsService],
  exports: [DomainsService],
})
export class DomainsModule {}
