import { Global, Module } from '@nestjs/common';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';

/**
 * Shared auth-core services.
 * Made @Global so BootstrapModule, AuthModule, and any module that needs
 * password hashing, MFA, or sessions can inject them without re-declaring.
 */
@Global()
@Module({
  providers: [PasswordService, MfaService, SessionService],
  exports: [PasswordService, MfaService, SessionService],
})
export class AuthCoreModule {}
