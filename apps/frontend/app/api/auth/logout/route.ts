import { NextRequest, NextResponse } from 'next/server';
import {
  TokenPair,
  askedForAnother,
  clearTokens,
  endingIn,
  isFresh,
  olderSessions,
  readTokens,
  rememberEnding,
  sessionsIn,
  storeTokens,
} from '@/lib/server/session';
import {
  endRefreshToken,
  endSessions,
  endedTheSession,
  forgetLegacySessions,
  rotateTokens,
  sessionChanged,
  upstream,
} from '@/lib/server/upstream';

export async function POST(request: NextRequest) {
  const sessions = sessionsIn(request);
  const { accessToken, refreshToken, session } = readTokens(request, sessions);
  if (askedForAnother(request, session)) return sessionChanged();

  const older = olderSessions(sessions, session);
  const ended = await endSessions(request, older);
  const notSignedOut = (status: number) => {
    const response = NextResponse.json({ message: 'Could not sign out, try again' }, { status });
    clearTokens(response, ended);
    return response;
  };
  if (ended.length < older.length) return notSignedOut(503);

  let token = isFresh(accessToken) ? accessToken : undefined;
  let rotated: TokenPair | null = null;
  const rotate = async (): Promise<NextResponse | null> => {
    if (!refreshToken) return null;
    const outcome = await rotateTokens(request, { refreshToken, accessToken });
    if (outcome.kind === 'unavailable') return notSignedOut(503);
    rotated = outcome.kind === 'rotated' ? outcome.tokens : null;
    token = rotated?.accessToken;
    return null;
  };

  if (!token) {
    const failure = await rotate();
    if (failure) return failure;
  }
  if (token) {
    let result = await upstream(request, 'engine', '/auth/logout', { method: 'POST' }, token);
    if (result.status === 401 && !rotated) {
      const failure = await rotate();
      if (failure) return failure;
      if (token) result = await upstream(request, 'engine', '/auth/logout', { method: 'POST' }, token);
    }
    if (endedTheSession(result)) {
      const response = notSignedOut(result.status);
      clearTokens(response, [session]);
      return response;
    }
    if (result.status === 401 && rotated) await endRefreshToken(request, (rotated as TokenPair).refreshToken);
    if (result.status !== 204 && result.status !== 401) {
      const response = notSignedOut(result.status >= 500 ? result.status : 502);
      if (rotated) storeTokens(response, rotated, session);
      return response;
    }
  }
  const response = new NextResponse(null, { status: 204 });
  const over = [...ended, session];
  clearTokens(response, over);
  rememberEnding(request, response, endingIn(request, sessions).filter((id) => !over.includes(id)));
  await forgetLegacySessions(request, response, sessions);
  return response;
}
