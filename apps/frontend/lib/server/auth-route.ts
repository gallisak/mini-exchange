import { NextRequest, NextResponse } from 'next/server';
import { TokenPair, claimsOf, storeTokens } from './session';
import { upstream } from './upstream';

export async function signIn(request: NextRequest, path: '/auth/login' | '/auth/register') {
  const credentials = await request.json().catch(() => ({}));
  const result = await upstream(request, 'engine', path, {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
  if (result.status >= 400) return NextResponse.json(result.body, { status: result.status });
  const tokens = result.body as TokenPair;
  const claims = claimsOf(tokens.accessToken);
  const response = NextResponse.json({
    user: claims && { id: claims.id, email: claims.email, role: claims.role },
  });
  storeTokens(response, tokens);
  return response;
}
