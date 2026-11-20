import { Module } from '@nestjs/common';
import { MailController } from './mail.controller.js';

@Module({
  controllers: [MailController],
})
export class MailModule {}
