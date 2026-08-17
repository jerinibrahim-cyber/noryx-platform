import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import type { ApiError } from "@noryx/shared-types";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("AllExceptionsFilter");

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "An unexpected error occurred.";

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = HttpStatus[status] ?? "HTTP_ERROR";
      message =
        typeof body === "string" ? body : ((body as any)?.message ?? message);
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
    }

    const errorBody: ApiError = { ok: false, error: { code, message } };
    response.status(status).json(errorBody);
  }
}
