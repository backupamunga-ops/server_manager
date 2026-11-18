/** Deployments module — Phase 1+2 stub. Full state machine wired in CL-051, CL-053. */
import { Module } from '@nestjs/common';
import { DeploymentsController } from './deployments.controller.js';
import { DeploymentsService } from './deployments.service.js';

@Module({
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
})
export class DeploymentsModule {}
