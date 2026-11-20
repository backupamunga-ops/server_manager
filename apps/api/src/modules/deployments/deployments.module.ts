import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { DomainsModule } from '../domains/domains.module.js';
import { DeploymentsController } from './deployments.controller.js';
import { DeploymentsService } from './deployments.service.js';
import { BuildsService } from '../builds/builds.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';

@Module({
  imports: [AgentModule, DomainsModule, SecretsModule],
  controllers: [DeploymentsController],
  providers: [DeploymentsService, BuildsService],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
