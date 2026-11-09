import { NextRequest, NextResponse } from 'next/server';
import {
  TokenPair,
  claimsOf,
  clearTokens,
  endingIn,
  isFresh,
  readTokens,
  rotatedElsewhere,
  sessionsIn,
  storeTokens,
} from '@/lib/server/session';
import { endAndForget, rotateTokens, unavailable, upstream } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const userOf = (token: string) => {
  const claims = claimsOf(token);
  return claims && { id: claims.id, email: claims.email, role: claims.role };
};

export async function GET(request: NextRequest) {
  const sessions = sessionsIn(request);
  const ending = endingIn(request, sessions);
  const { accessToken, refreshToken, session } = readTokens(request, sessions, ending);
  const answer = async (user: ReturnType<typeof userOf>, tokens?: TokenPair) => {
    const response = NextResponse.json({ user, session: user ? session : null });
    if (tokens) storeTokens(response, tokens, session);
    if (!user) clearTokens(response, [session]);
    await endAndForget(request, response, sessions, { end: ending });
    return response;
  };
  if (isFresh(accessToken)) {
    if (!rotatedElsewhere(accessToken)) return answer(userOf(accessToken));
    const check = await upstream(request, 'engine', '/auth/session', {}, accessToken);
    if (check.status === 200) return answer(userOf(accessToken));
    if (check.status !== 401) return unavailable();
  }
  if (!refreshToken) return answer(null);

  const outcome = await rotateTokens(request, { refreshToken, accessToken });
  if (outcome.kind === 'unavailable') return unavailable();
  if (outcome.kind === 'invalid') return answer(null);
  return answer(userOf(outcome.tokens.accessToken), outcome.tokens);
}
