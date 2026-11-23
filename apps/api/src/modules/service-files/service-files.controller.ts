import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { basename } from 'node:path';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { SessionGuard } from '../../common/guards/session.guard.js';
import { ServiceFilesService } from './service-files.service.js';

/** Express request augmented by NestFactory.create({ rawBody: true }). */
interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

class WriteFileDto {
  @IsString()
  @MaxLength(512)
  path!: string;

  @IsString()
  @MaxLength(2 * 1024 * 1024)
  content!: string;
}

class MkdirDto {
  @IsString()
  @MaxLength(512)
  path!: string;
}

class ExtractZipDto {
  @IsString()
  uploadId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  path?: string;
}

class RedeployZipDto {
  @IsString()
  uploadId!: string;
}

/** File manager for the LIVE deployment of an application service. */
@ApiTags('services')
@Controller('services/:serviceId/files')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class ServiceFilesController {
  constructor(private readonly files: ServiceFilesService) {}

  @Get()
  async list(
    @Param('serviceId') serviceId: string,
    @Query('path') path: string,
    @Query('search') search: string,
    @CurrentUser() user: { userId: string },
  ) {
    if (search && search.trim()) {
      return await this.files.search(user.userId, serviceId, search);
    }
    return await this.files.list(user.userId, serviceId, path ?? '');
  }

  @Post('rename')
  @HttpCode(200)
  async rename(
    @Param('serviceId') serviceId: string,
    @Body() body: { from?: string; to?: string },
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.rename(user.userId, serviceId, String(body.from ?? ''), String(body.to ?? ''));
  }

  @Post('copy')
  @HttpCode(200)
  async copy(
    @Param('serviceId') serviceId: string,
    @Body() body: { from?: string; to?: string },
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.copy(user.userId, serviceId, String(body.from ?? ''), String(body.to ?? ''));
  }

  @Get('content')
  async read(
    @Param('serviceId') serviceId: string,
    @Query('path') path: string,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.readContent(user.userId, serviceId, path ?? '');
  }

  /** Raw download — any file type; disp=inline previews in the browser. */
  @Get('raw')
  async raw(
    @Param('serviceId') serviceId: string,
    @Query('path') path: string,
    @Query('disp') disp: string,
    @Res() res: Response,
    @CurrentUser() user: { userId: string },
  ): Promise<void> {
    const { data } = await this.files.readRaw(user.userId, serviceId, path ?? '');
    const name = basename(String(path ?? 'download')).replace(/["\\\r\n]/g, '') || 'download';
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    const inlineMime: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
      '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.css': 'text/css',
      '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
    };
    if (disp === 'inline') {
      const mime = inlineMime[ext] ?? 'application/octet-stream';
      res.setHeader('Content-Type', `${mime}; charset=utf-8`);
      res.setHeader('Content-Disposition', `inline; filename="${name}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  }

  @Put('content')
  @UsePipes(new ValidationPipe({ transform: true }))
  async write(
    @Param('serviceId') serviceId: string,
    @Body() body: WriteFileDto,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.writeContent(user.userId, serviceId, body.path, body.content);
  }

  /** Binary-safe upload — raw octet-stream body, path via query string. */
  @Put('upload')
  async upload(
    @Param('serviceId') serviceId: string,
    @Query('path') path: string,
    @Req() req: RequestWithRawBody,
    @CurrentUser() user: { userId: string },
  ) {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw) || raw.length === 0) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'No file data received.' });
    }
    return await this.files.uploadFile(user.userId, serviceId, path ?? '', raw);
  }

  @Post('mkdir')
  @UsePipes(new ValidationPipe({ transform: true }))
  async mkdir(
    @Param('serviceId') serviceId: string,
    @Body() body: MkdirDto,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.mkdirp(user.userId, serviceId, body.path);
  }

  @Delete()
  async remove(
    @Param('serviceId') serviceId: string,
    @Query('path') path: string,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.remove(user.userId, serviceId, path ?? '');
  }

  @Post('extract')
  @UsePipes(new ValidationPipe({ transform: true }))
  async extract(
    @Param('serviceId') serviceId: string,
    @Body() body: ExtractZipDto,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.extract(user.userId, serviceId, body.uploadId, body.path ?? '');
  }

  @Post('redeploy-zip')
  @UsePipes(new ValidationPipe({ transform: true }))
  async redeployZip(
    @Param('serviceId') serviceId: string,
    @Body() body: RedeployZipDto,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.redeployZip(user.userId, serviceId, body.uploadId);
  }
}

/** Restart is service-scoped (no /files segment) so it reads naturally. */
@ApiTags('services')
@Controller('services/:serviceId/restart')
@UseGuards(SessionGuard)
@ApiBearerAuth()
export class ServiceRestartController {
  constructor(private readonly files: ServiceFilesService) {}

  @Post()
  async restart(
    @Param('serviceId') serviceId: string,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.restart(user.userId, serviceId);
  }
}
