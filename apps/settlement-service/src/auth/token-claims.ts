import { UnauthorizedException } from '@nestjs/common';

const ACCESS_TOKEN = 'access';

export interface TokenClaims {
  typ?: unknown;
  aud?: unknown;
  jti?: unknown;
}

export function assertAccessClaims(payload: TokenClaims): void {
  const issuedBeforeTypes = payload.typ === undefined && payload.aud === undefined && payload.jti === undefined;
  if (payload.typ !== ACCESS_TOKEN && !issuedBeforeTypes) throw new UnauthorizedException();
}
