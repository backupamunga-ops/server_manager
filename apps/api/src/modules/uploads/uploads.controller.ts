import {
  Body,
  Controller,
  Param,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

/** Express request augmented by NestFactory.create({ rawBody: true }). */
interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsString, Max, Min } from 'class-validator';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { UploadsService } from './uploads.service.js';

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

  @Put(':uploadId/receive')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }))
  async receive(
    @Param('uploadId') uploadId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: RequestWithRawBody,
  ) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      const rawBody = req.rawBody;
      if (rawBody && Buffer.isBuffer(rawBody) && rawBody.length > 0) {
        const sha256 = (req.query?.sha256 as string | undefined) ?? '';
        await this.uploads.receive(uploadId, rawBody, sha256);
        return { received: true, size: rawBody.length };
      }
      return { error: { code: 'NO_FILE', message: 'No file in request.' } };
    }
    const sha256 = (req.query?.sha256 as string | undefined) ?? '';
    await this.uploads.receive(uploadId, file.buffer, sha256);
    return { received: true, size: file.size };
  }

  @Post(':uploadId/finalize')
  async finalize(@Param('uploadId') uploadId: string, @Body() body: UploadFinalizeDto) {
    return await this.uploads.finalize(uploadId, body.sha256);
  }
}
