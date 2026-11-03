import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.SETTLEMENT_INTERNAL_KEY;
    const provided = context.switchToHttp().getRequest<Request>().header('x-internal-key');
    if (!expected || !provided || !timingSafeEqual(digest(expected), digest(provided))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
