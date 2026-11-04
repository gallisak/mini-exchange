import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';

const DEPENDENCY_DOWN =
  /ECONNREFUSED|ETIMEDOUT|ECONNRESET|Connection is closed|Connection terminated|Stream isn't writeable|max retries per request/i;

export function isDependencyUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'MaxRetriesPerRequestError' || DEPENDENCY_DOWN.test(error.message))
  );
}

@Catch()
export class DependencyUnavailableFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(DependencyUnavailableFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!isDependencyUnavailable(exception) || host.getType() !== 'http') {
      super.catch(exception, host);
      return;
    }
    this.logger.warn(`Answering 503, a dependency is unavailable: ${(exception as Error).message}`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Service temporarily unavailable, try again shortly',
      });
  }
}
