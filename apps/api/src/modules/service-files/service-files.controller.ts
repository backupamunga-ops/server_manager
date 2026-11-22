import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
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
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.list(user.userId, serviceId, path ?? '');
  }

  @Get('content')
  async read(
    @Param('serviceId') serviceId: string,
    @Query('path') path: string,
    @CurrentUser() user: { userId: string },
  ) {
    return await this.files.readContent(user.userId, serviceId, path ?? '');
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
