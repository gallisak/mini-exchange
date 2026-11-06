import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { isUUID } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../common/env';
import { SessionRevocations } from './session-revocations.service';

export interface AuthUser {
  userId: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly revocations: SessionRevocations) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: requireEnv('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: { sub?: unknown; role?: unknown; aud?: unknown; sid?: unknown }): Promise<AuthUser> {
    if (typeof payload.sub !== 'string' || !isUUID(payload.sub) || payload.aud !== undefined) {
      throw new UnauthorizedException();
    }
    if (typeof payload.sid === 'string' && (await this.revocations.isRevoked(payload.sid))) {
      throw new UnauthorizedException();
    }
    return {
      userId: payload.sub.toLowerCase(),
      role: typeof payload.role === 'string' ? payload.role : 'user',
    };
  }
}
