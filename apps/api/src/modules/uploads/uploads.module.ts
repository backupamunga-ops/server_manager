/**
 * Uploads module — Phase 1+2 stub.
 *
 * Full ZIP upload init + finalize with traversal/symlink/quota validation
 * is wired in CL-050. The endpoint shape matches the contract.
 */
import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
})
export class UploadsModule {}
