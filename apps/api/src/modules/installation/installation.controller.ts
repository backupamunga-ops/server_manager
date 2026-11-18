import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InstallationService } from './installation.service.js';
import { Public } from '../../common/decorators/public.decorator.js';
import type { InstallationStatusResponse } from '@cloudlane/contracts';

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
