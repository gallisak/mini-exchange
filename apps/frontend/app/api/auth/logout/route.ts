import { NextRequest, NextResponse } from 'next/server';
import { clearTokens, isFresh, readTokens, storeTokens, TokenPair } from '@/lib/server/session';
import { rotateTokens, upstream } from '@/lib/server/upstream';

const notSignedOut = (status: number) =>
  NextResponse.json({ message: 'Could not sign out, try again' }, { status });

export async function POST(request: NextRequest) {
  const { accessToken, refreshToken } = readTokens(request);
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
    if (result.status === 401 && rotated) {
      const response = notSignedOut(502);
      storeTokens(response, rotated);
      return response;
    }
    if (result.status !== 204 && result.status !== 401) {
      const response = notSignedOut(result.status >= 500 ? result.status : 502);
      if (rotated) storeTokens(response, rotated);
      return response;
    }
  }
  const response = new NextResponse(null, { status: 204 });
  clearTokens(response);
  return response;
}
