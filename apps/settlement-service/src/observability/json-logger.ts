import { LoggerService } from '@nestjs/common';
import { currentTraceId } from './trace-context';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'fatal';

export class JsonLogger implements LoggerService {
  constructor(private readonly service: string) {}

  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]) {
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const stack =
      message instanceof Error
        ? message.stack
        : typeof rest[0] === 'string' && level === 'error'
          ? rest[0]
          : undefined;
    const line = {
      time: new Date().toISOString(),
      level,
      service: this.service,
      instance: process.env.INSTANCE_ID,
      context,
      traceId: currentTraceId(),
      message:
        message instanceof Error
          ? message.message
          : typeof message === 'string'
            ? message
            : JSON.stringify(message),
      ...(stack ? { stack } : {}),
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}
