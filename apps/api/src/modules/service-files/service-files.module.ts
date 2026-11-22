import { Module } from '@nestjs/common';
import { ServiceFilesController, ServiceRestartController } from './service-files.controller.js';
import { ServiceFilesService } from './service-files.service.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { DeploymentsModule } from '../deployments/deployments.module.js';

@Module({
  imports: [UploadsModule, DeploymentsModule],
  controllers: [ServiceFilesController, ServiceRestartController],
  providers: [ServiceFilesService],
})
export class ServiceFilesModule {}
