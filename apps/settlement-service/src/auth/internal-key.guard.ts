import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

const digest = (value: string) => createHash('sha256').update(value).digest();

abstract class HeaderKeyGuard implements CanActivate {
  protected constructor(private readonly keyEnv: string) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env[this.keyEnv];
    const provided = context.switchToHttp().getRequest<Request>().header('x-internal-key');
    if (!expected || !provided || !timingSafeEqual(digest(expected), digest(provided))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Injectable()
export class InternalKeyGuard extends HeaderKeyGuard {
  constructor() {
    super('SETTLEMENT_INTERNAL_KEY');
  }
}

@Injectable()
export class ReconciliationKeyGuard extends HeaderKeyGuard {
  constructor() {
    super('RECONCILIATION_API_KEY');
  }
}
