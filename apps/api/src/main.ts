import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  // Raw binary uploads (PUT /uploads/:id/receive with octet-stream): parse the
  // body into a Buffer so the controller's rawBody fallback receives bytes.
  if (typeof (app as NestExpressApplication).useBodyParser === 'function') {
    app.useBodyParser('raw', { limit: '150mb', type: ['application/octet-stream', 'application/zip'] });
  }

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

  app.setGlobalPrefix('api/v1', {
    exclude: ['/health', '/api/v1/health'],
  });

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(port);
  const logger = new Logger('CloudlaneAPI');
  logger.log(`Cloudlane API listening on port ${port}`);
}

void bootstrap();
