import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { DomainsModule } from '../domains/domains.module.js';
import { DeploymentsController } from './deployments.controller.js';
import { DeploymentsService } from './deployments.service.js';

@Module({
  imports: [AgentModule, DomainsModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
