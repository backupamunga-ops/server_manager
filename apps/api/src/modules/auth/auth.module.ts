import { Module } from '@nestjs/common';
import { AuthCoreModule } from './auth-core.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { SessionMiddleware } from './session.middleware.js';

@Module({
  imports: [AuthCoreModule],
  controllers: [AuthController],
  providers: [AuthService, SessionMiddleware],
  exports: [AuthService, SessionMiddleware],
})
export class AuthModule {}
