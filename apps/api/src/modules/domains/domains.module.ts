import { Module } from '@nestjs/common';
import { DomainPipelineService } from '../workspace/domain-pipeline.service.js';
import { DomainsController } from './domains.controller.js';
import { OnDemandAskController } from './ondemand-ask.controller.js';
import { DomainsService } from './domains.service.js';

@Module({
  controllers: [DomainsController, OnDemandAskController],
  providers: [DomainsService, DomainPipelineService],
  exports: [DomainsService, DomainPipelineService],
})
export class DomainsModule {}
