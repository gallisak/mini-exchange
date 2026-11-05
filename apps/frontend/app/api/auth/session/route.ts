import { NextRequest, NextResponse } from 'next/server';
import { claimsOf, clearTokens, isFresh, readTokens, storeTokens } from '@/lib/server/session';
import { rotateTokens, unavailable } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const userOf = (token: string) => {
  const claims = claimsOf(token);
  return claims && { id: claims.id, email: claims.email, role: claims.role };
};

export async function GET(request: NextRequest) {
  const { accessToken, refreshToken } = readTokens(request);
  if (isFresh(accessToken)) return NextResponse.json({ user: userOf(accessToken) });
  if (!refreshToken) return NextResponse.json({ user: null });

  const outcome = await rotateTokens(request, { refreshToken, accessToken });
  if (outcome.kind === 'unavailable') return unavailable();
  if (outcome.kind === 'invalid') {
    const response = NextResponse.json({ user: null });
    clearTokens(response);
    return response;
  }
  const response = NextResponse.json({ user: userOf(outcome.tokens.accessToken) });
  storeTokens(response, outcome.tokens);
  return response;
}
