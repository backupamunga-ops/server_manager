import { Module } from '@nestjs/common';
import { MailController } from './mail.controller.js';
import { MailStackController } from './mail-stack.controller.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [StorageModule],
  controllers: [MailController, MailStackController],
})
export class MailModule {}
