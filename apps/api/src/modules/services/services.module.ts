/**
 * Services module — Phase 1+2 stub.
 *
 * The full service creation flow (ZIP + GitHub) is wired in CL-050, CL-053,
 * CL-055, CL-056. This module exposes the read endpoints so the dashboard
 * can render service lists and detail pages while the deployment engine
 * is being implemented.
 */
import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';

@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
