import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller.js';
import { ServicesService } from './services.service.js';
import { DeploymentsModule } from '../deployments/deployments.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';

@Module({
  imports: [DeploymentsModule, UploadsModule],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
