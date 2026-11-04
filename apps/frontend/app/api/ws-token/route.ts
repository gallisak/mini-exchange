import { NextRequest, NextResponse } from 'next/server';
import { isFresh, readTokens, storeTokens } from '@/lib/server/session';
import { rotateTokens, unauthorized, unavailable } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { accessToken, refreshToken } = readTokens(request);
  if (isFresh(accessToken)) return NextResponse.json({ token: accessToken });
  if (!refreshToken) return unauthorized();

  const outcome = await rotateTokens(request, refreshToken);
  if (outcome.kind === 'unavailable') return unavailable();
  if (outcome.kind === 'invalid') return unauthorized();
  const response = NextResponse.json({ token: outcome.tokens.accessToken });
  storeTokens(response, outcome.tokens);
  return response;
}
