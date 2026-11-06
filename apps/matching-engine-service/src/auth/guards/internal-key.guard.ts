import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ENGINE_INTERNAL_KEY;
    const request = context.switchToHttp().getRequest<Request>();
    const bearer = /^Bearer (.+)$/.exec(request.header('authorization') ?? '')?.[1];
    const provided = request.header('x-internal-key') ?? bearer;
    if (!expected || !provided || !timingSafeEqual(digest(expected), digest(provided))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
