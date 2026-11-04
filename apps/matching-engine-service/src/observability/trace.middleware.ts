import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { acceptTraceId, runWithTrace } from './trace-context';

export const TRACE_HEADER = 'x-request-id';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(request: Request, response: Response, next: NextFunction): void {
    const traceId = acceptTraceId(request.header(TRACE_HEADER));
    const started = process.hrtime.bigint();
    response.setHeader(TRACE_HEADER, traceId);
    response.on('finish', () =>
      runWithTrace(traceId, () =>
        this.logger.log(
          `${request.method} ${request.originalUrl} ${response.statusCode} ${
            Number(process.hrtime.bigint() - started) / 1e6
          }ms`,
        ),
      ),
    );
    runWithTrace(traceId, next);
  }
}
