import { NextRequest, NextResponse } from 'next/server';
import {
  TokenPair,
  askedForAnother,
  clearLegacyCookies,
  clearTokens,
  readTokens,
  rememberEnding,
  sessionsIn,
  storeTokens,
} from '@/lib/server/session';
import {
  callRotating,
  endLegacySessions,
  endSessions,
  endedTheSession,
  sessionChanged,
  upstream,
} from '@/lib/server/upstream';
import { SIGN_OUT_END_TIMEOUT_MS } from '@/lib/timeouts';

export async function POST(request: NextRequest) {
  const sessions = sessionsIn(request);
  const { accessToken, refreshToken, session } = readTokens(request, sessions);
  if (askedForAnother(request, session)) return sessionChanged();

  const others = sessions.filter((id) => id !== session);
  const ended = await endSessions(request, others, SIGN_OUT_END_TIMEOUT_MS);
  const notSignedOut = (status: number, rotated: TokenPair | null = null) => {
    const response = NextResponse.json({ message: 'Could not sign out, try again' }, { status });
    clearTokens(response, ended);
    if (rotated) storeTokens(response, rotated, session);
    return response;
  };
  if (ended.length < others.length) return notSignedOut(503);

  const outcome = await callRotating(
    request,
    { accessToken, refreshToken },
    (token) => upstream(request, 'engine', '/auth/logout', { method: 'POST' }, token),
    SIGN_OUT_END_TIMEOUT_MS,
  );
  if (outcome.kind === 'unavailable') return notSignedOut(503, outcome.rotated);
  if (outcome.kind === 'answered' && outcome.result.status !== 204 && !endedTheSession(outcome.result)) {
    const { status } = outcome.result;
    return notSignedOut(status >= 500 ? status : 502, outcome.rotated);
  }

  const response = new NextResponse(null, { status: 204 });
  clearTokens(response, [...ended, session]);
  rememberEnding(request, response, []);
  clearLegacyCookies(response, await endLegacySessions(request, sessions));
  return response;
}
