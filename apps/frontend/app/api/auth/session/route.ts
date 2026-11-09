import { NextRequest, NextResponse } from 'next/server';
import {
  TokenPair,
  claimsOf,
  clearLegacyCookies,
  clearTokens,
  isFresh,
  readTokens,
  sessionsIn,
  storeTokens,
} from '@/lib/server/session';
import { endLegacySessions, endListed, rotateTokens, unavailable } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const userOf = (token: string) => {
  const claims = claimsOf(token);
  return claims && { id: claims.id, email: claims.email, role: claims.role };
};

export async function GET(request: NextRequest) {
  const sessions = sessionsIn(request);
  const { accessToken, refreshToken, session } = readTokens(request, sessions);
  const answer = async (user: ReturnType<typeof userOf>, tokens?: TokenPair) => {
    const response = NextResponse.json({ user, session: user ? session : null });
    if (tokens) storeTokens(response, tokens, session);
    if (!user) clearTokens(response, [session]);
    const [ended, legacy] = await Promise.all([endListed(request, sessions), endLegacySessions(request, sessions)]);
    clearTokens(response, ended);
    clearLegacyCookies(response, legacy);
    return response;
  };
  if (isFresh(accessToken)) return answer(userOf(accessToken));
  if (!refreshToken) return answer(null);

  const outcome = await rotateTokens(request, { refreshToken, accessToken });
  if (outcome.kind === 'unavailable') return unavailable();
  if (outcome.kind === 'invalid') return answer(null);
  return answer(userOf(outcome.tokens.accessToken), outcome.tokens);
}
