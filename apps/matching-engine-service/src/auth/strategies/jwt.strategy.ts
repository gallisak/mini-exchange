import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { requireEnv } from '../../common/env';

export interface JwtPayload {
  sub: string;
  sid?: string;
  email: string;
  role?: string;
  exp: number;
  aud?: unknown;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: string;
  sessionId?: string;
  expiresAt: number;
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

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (payload.aud !== undefined) throw new UnauthorizedException();
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role ?? 'user',
      sessionId: payload.sid,
      expiresAt: payload.exp,
    };
  }
}
