import { NextRequest, NextResponse } from 'next/server';
import { clearTokens, isFresh, readTokens } from '@/lib/server/session';
import { rotateTokens, upstream } from '@/lib/server/upstream';

export async function POST(request: NextRequest) {
  const { accessToken, refreshToken } = readTokens(request);
  let token = isFresh(accessToken) ? accessToken : undefined;
  if (!token && refreshToken) {
    const outcome = await rotateTokens(request, refreshToken);
    if (outcome.kind === 'rotated') token = outcome.tokens.accessToken;
  }
  if (token) await upstream(request, 'engine', '/auth/logout', { method: 'POST' }, token);
  const response = new NextResponse(null, { status: 204 });
  clearTokens(response);
  return response;
}
