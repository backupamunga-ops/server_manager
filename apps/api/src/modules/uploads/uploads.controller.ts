import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UploadsService } from './uploads.service.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { IsNumber, IsString, Max, Min } from 'class-validator';

class UploadInitDto {
  @IsString() filename!: string;
  @Min(1) @Max(100 * 1024 * 1024) size!: number;
  @IsString() mimeType!: string;
}

class UploadFinalizeDto {
  @IsString() sha256!: string;
}

@ApiTags('uploads')
@Controller('uploads')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('init')
  async init(@Body() body: UploadInitDto) {
    return await this.uploads.init(body.filename, body.size, body.mimeType);
  }

  @Post(':uploadId/finalize')
  async finalize(@Param('uploadId') uploadId: string, @Body() body: UploadFinalizeDto) {
    return await this.uploads.finalize(uploadId, body.sha256);
  }
}
