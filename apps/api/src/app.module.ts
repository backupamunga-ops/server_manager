import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './common/prisma.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { SecretsModule } from './modules/secrets/secrets.module.js';
import { AuthCoreModule } from './modules/auth/auth-core.module.js';
import { InstallationModule } from './modules/installation/installation.module.js';
import { BootstrapModule } from './modules/bootstrap/bootstrap.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { SessionMiddleware } from './modules/auth/session.middleware.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { ServicesModule } from './modules/services/services.module.js';
import { DeploymentsModule } from './modules/deployments/deployments.module.js';
import { UploadsModule } from './modules/uploads/uploads.module.js';
import { GithubModule } from './modules/github/github.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      cache: true,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    SecretsModule,
    AuthCoreModule,
    InstallationModule,
    BootstrapModule,
    AuthModule,
    ProjectsModule,
    ServicesModule,
    DeploymentsModule,
    UploadsModule,
    GithubModule,
    AgentModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}
