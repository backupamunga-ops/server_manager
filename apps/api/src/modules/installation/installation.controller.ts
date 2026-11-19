import type { InstallationStatusResponse } from '@cloudlane/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator.js';
import { InstallationService } from './installation.service.js';

@ApiTags('installation')
@Controller('installation')
export class InstallationController {
  constructor(private readonly installation: InstallationService) {}

  @Public()
  @Get('status')
  async status(): Promise<InstallationStatusResponse> {
    const s = await this.installation.getStatus();
    return s;
  }
}
