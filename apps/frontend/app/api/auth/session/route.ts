import { NextRequest, NextResponse } from 'next/server';
import { TokenPair, claimsOf, clearTokens, isFresh, olderSessions, readTokens, storeTokens } from '@/lib/server/session';
import { rotateTokens, unavailable } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const userOf = (token: string) => {
  const claims = claimsOf(token);
  return claims && { id: claims.id, email: claims.email, role: claims.role };
};

export async function GET(request: NextRequest) {
  const { accessToken, refreshToken, session } = readTokens(request);
  const answer = (body: unknown, tokens?: TokenPair) => {
    const response = NextResponse.json(body);
    clearTokens(response, olderSessions(request, session));
    if (tokens) storeTokens(response, tokens, session);
    return response;
  };
  if (isFresh(accessToken)) return answer({ user: userOf(accessToken) });
  if (!refreshToken) return answer({ user: null });

  const outcome = await rotateTokens(request, { refreshToken, accessToken });
  if (outcome.kind === 'unavailable') return unavailable();
  if (outcome.kind === 'invalid') {
    const response = answer({ user: null });
    clearTokens(response, [session]);
    return response;
  }
  return answer({ user: userOf(outcome.tokens.accessToken) }, outcome.tokens);
}
