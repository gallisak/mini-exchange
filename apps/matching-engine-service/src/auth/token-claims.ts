import { UnauthorizedException } from '@nestjs/common';

export const ACCESS_TOKEN = 'access';
export const REFRESH_TOKEN = 'refresh';
export const WS_TICKET = 'ws';

export interface TokenClaims {
  typ?: unknown;
  aud?: unknown;
  jti?: unknown;
}

export function assertAccessClaims(payload: TokenClaims): void {
  const issuedBeforeTypes = payload.typ === undefined && payload.aud === undefined && payload.jti === undefined;
  if (payload.typ !== ACCESS_TOKEN && !issuedBeforeTypes) throw new UnauthorizedException();
}

export function isTokenOfType(payload: TokenClaims, type: string): boolean {
  return payload.typ === undefined || payload.typ === type;
}
