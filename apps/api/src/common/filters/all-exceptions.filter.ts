import { randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request, Response } from 'express';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request.headers['x-request-id'] as string) || randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: Record<string, unknown> | undefined;

    if (typeof exception === 'object' && exception !== null) {
      const ex = exception as {
        status?: number;
        statusCode?: number;
        message?: string;
        response?: { code?: string; message?: string; details?: Record<string, unknown> };
        name?: string;
      };

      status = ex.status ?? ex.statusCode ?? status;

      if (ex.response?.code) {
        code = ex.response.code;
      } else if (ex.name === 'UnauthorizedError') {
        code = 'UNAUTHORIZED';
        status = HttpStatus.UNAUTHORIZED;
      } else if (status === HttpStatus.NOT_FOUND) {
        code = 'NOT_FOUND';
      } else if (status === HttpStatus.CONFLICT) {
        code = 'CONFLICT';
      } else if (status === HttpStatus.TOO_MANY_REQUESTS) {
        code = 'RATE_LIMITED';
      } else if (status === HttpStatus.UNPROCESSABLE_ENTITY) {
        code = 'VALIDATION_ERROR';
      }

      if (ex.response?.message) {
        message = ex.response.message;
      } else if (ex.message && status !== HttpStatus.INTERNAL_SERVER_ERROR) {
        message = ex.message;
      }

      if (ex.response?.details) {
        details = ex.response.details;
      }
    }

    if (status >= 500) {
      this.logger.error(
        `request_id=${requestId} method=${request.method} path=${request.url} status=${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ApiErrorBody = {
      error: {
        code,
        message,
        requestId,
      },
    };

    if (details) {
      body.error.details = details;
    }

    response.status(status).json(body);
  }
}
