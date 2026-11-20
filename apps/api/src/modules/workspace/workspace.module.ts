import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DeploymentsModule } from '../deployments/deployments.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ServicesModule } from '../services/services.module.js';
import { DatabasePipelineService } from './database-pipeline.service.js';
import { DomainPipelineService } from './domain-pipeline.service.js';
import { AppPipelineService } from './app-pipeline.service.js';
import { StoragePipelineService } from './storage-pipeline.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { CronRunnerService } from './cron-runner.service.js';
import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';

@Module({
  imports: [SecretsModule, AgentModule, AuditModule, DeploymentsModule, ServicesModule, StorageModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService, DatabasePipelineService, DomainPipelineService, AppPipelineService,
    StoragePipelineService, CronRunnerService],
})
export class WorkspaceModule {}
