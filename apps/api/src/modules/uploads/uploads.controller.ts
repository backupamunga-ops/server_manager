import { Body, Controller, Param, Post, Put, UseGuards, UseInterceptors, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { UploadsService } from './uploads.service.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { IsNumber, IsString, Max, Min } from 'class-validator';

class UploadInitDto {
  @IsString() filename!: string;
  @Min(1) @Max(50 * 1024 * 1024) size!: number;
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

  /**
   * Receive the actual file data. This endpoint accepts the raw ZIP body.
   * The SHA256 is passed as a query parameter for verification.
   */
  @Put(':uploadId/receive')
  async receive(
    @Param('uploadId') uploadId: string,
    @Req() req: Request,
  ) {
    const sha256 = (req.query.sha256 as string) || '';
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      return { error: { code: 'NO_BODY', message: 'Request body is empty.' } };
    }
    await this.uploads.receive(uploadId, rawBody, sha256);
    return { received: true, size: rawBody.length };
  }

  @Post(':uploadId/finalize')
  async finalize(@Param('uploadId') uploadId: string, @Body() body: UploadFinalizeDto) {
    return await this.uploads.finalize(uploadId, body.sha256);
  }
}
