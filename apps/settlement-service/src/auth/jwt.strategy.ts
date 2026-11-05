import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { isUUID } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';

export interface AuthUser {
  userId: string;
  role: string;
  issuedAt: number;
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

  validate(payload: { sub?: unknown; role?: unknown; iat?: unknown; aud?: unknown }): AuthUser {
    if (typeof payload.sub !== 'string' || !isUUID(payload.sub) || payload.aud !== undefined) {
      throw new UnauthorizedException();
    }
    return {
      userId: payload.sub.toLowerCase(),
      role: typeof payload.role === 'string' ? payload.role : 'user',
      issuedAt: typeof payload.iat === 'number' ? payload.iat : 0,
    };
  }
}
