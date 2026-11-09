import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, hkdfSync, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';
import { RateLimitName, rateLimitPolicy } from './rate-limit.policies';
import { RateLimitService } from './rate-limit.service';

const RATE_LIMIT = 'rateLimit';
const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;

const digest = (value: string) => createHash('sha256').update(value).digest();

export const proxyHeaderFor = (key: string) => Buffer.from(hkdfSync('sha256', key, '', 'mx-proxy', 32)).toString('hex');

let expected: Buffer | undefined;

const expectedHeader = (key: string) => (expected ??= digest(proxyHeaderFor(key)));

export function clientAddress(request: Request): string | undefined {
  const key = process.env.FRONTEND_PROXY_KEY;
  const provided = request.header('x-proxy-key');
  const forwarded = request.header('x-client-ip');
  if (
    key &&
    provided &&
    forwarded &&
    ADDRESS.test(forwarded) &&
    timingSafeEqual(expectedHeader(key), digest(provided))
  ) {
    return `client:${forwarded}`;
  }
  return request.ip;
}

export const RateLimit = (name: RateLimitName) => SetMetadata(RATE_LIMIT, name);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const name = this.reflector.getAllAndOverride<RateLimitName | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!name) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { userId?: string } }>();
    const policy = rateLimitPolicy(name);
    const subject = policy.by === 'user' ? request.user?.userId : clientAddress(request);
    if (!subject) return true;

    let result;
    try {
      if (!this.limiter.isAvailable()) throw new Error('Redis is not connected');
      result = await this.limiter.hit(`${name}:${subject}`, policy.limit, policy.windowMs);
    } catch (error) {
      if (policy.failClosed) {
        this.logger.warn(`Refusing ${name} request, its rate limit cannot be checked: ${(error as Error).message}`);
        throw new ServiceUnavailableException('Service temporarily unavailable, try again shortly');
      }
      this.logger.warn(`Rate limit check skipped: ${(error as Error).message}`);
      return true;
    }
    if (result.allowed) return true;
    http
      .getResponse<Response>()
      .setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    throw new HttpException('Too many requests, slow down', HttpStatus.TOO_MANY_REQUESTS);
  }
}
