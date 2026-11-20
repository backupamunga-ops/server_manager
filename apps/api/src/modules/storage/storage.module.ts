import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller.js';
import { StorageObjectsService } from './storage-objects.service.js';

@Module({
  controllers: [StorageController],
  providers: [StorageObjectsService],
  exports: [StorageObjectsService],
})
export class StorageModule {}
