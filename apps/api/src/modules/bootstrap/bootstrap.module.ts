import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { BootstrapController } from './bootstrap.controller.js';
import { BootstrapService } from './bootstrap.service.js';

@Module({
  imports: [AuthCoreModule],
  controllers: [BootstrapController],
  providers: [BootstrapService],
  exports: [BootstrapService],
})
export class BootstrapModule {}
