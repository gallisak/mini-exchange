import { NextRequest, NextResponse } from 'next/server';
import { clearTokens, isFresh, readTokens } from '@/lib/server/session';
import { rotateTokens, upstream } from '@/lib/server/upstream';

const notSignedOut = (status: number) =>
  NextResponse.json({ message: 'Could not sign out, try again' }, { status });

export async function POST(request: NextRequest) {
  const { accessToken, refreshToken } = readTokens(request);
  let token = isFresh(accessToken) ? accessToken : undefined;
  if (!token && refreshToken) {
    const outcome = await rotateTokens(request, { refreshToken, accessToken });
    if (outcome.kind === 'unavailable') return notSignedOut(503);
    if (outcome.kind === 'rotated') token = outcome.tokens.accessToken;
  }
  if (token) {
    const result = await upstream(request, 'engine', '/auth/logout', { method: 'POST' }, token);
    if (result.status !== 204 && result.status !== 401) {
      return notSignedOut(result.status >= 500 ? result.status : 502);
    }
  }
  const response = new NextResponse(null, { status: 204 });
  clearTokens(response);
  return response;
}
