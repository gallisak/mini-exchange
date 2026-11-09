import { NextRequest, NextResponse } from 'next/server';
import {
  TokenPair,
  askedForAnother,
  clearTokens,
  endingIn,
  noteRotated,
  readTokens,
  rememberEnding,
  sessionsIn,
  storeTokens,
} from '@/lib/server/session';
import { callRotating, endAndForget, endedTheSession, sessionChanged, upstream } from '@/lib/server/upstream';
import { SIGN_OUT_END_TIMEOUT_MS } from '@/lib/timeouts';

export async function POST(request: NextRequest) {
  const sessions = sessionsIn(request);
  const ending = endingIn(request, sessions);
  const { accessToken, refreshToken, session } = readTokens(request, sessions, ending);
  if (askedForAnother(request, sessions, ending)) return sessionChanged();

  const others = [...sessions.keys()].filter((id) => id !== session);
  const forgotten = new NextResponse(null);
  const { left, oldLeft } = await endAndForget(request, forgotten, sessions, { end: others, timeout: SIGN_OUT_END_TIMEOUT_MS });
  const withForgotten = (response: NextResponse) => {
    for (const line of forgotten.headers.getSetCookie()) response.headers.append('set-cookie', line);
    return response;
  };
  const notSignedOut = (status: number, rotated: TokenPair | null = null) => {
    const response = NextResponse.json({ message: 'Could not sign out, try again' }, { status });
    if (rotated) {
      storeTokens(response, rotated, session);
      noteRotated(rotated);
    }
    return withForgotten(response);
  };
  if (left.length > 0 || oldLeft) return notSignedOut(503);

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
  clearTokens(response, [session]);
  rememberEnding(request, response, [...sessions.keys()]);
  return withForgotten(response);
}
