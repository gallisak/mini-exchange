import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { isUUID } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';

export interface AuthUser {
  userId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: { sub?: unknown }): AuthUser {
    if (typeof payload.sub !== 'string' || !isUUID(payload.sub)) {
      throw new UnauthorizedException();
    }
    return { userId: payload.sub.toLowerCase() };
  }
}
