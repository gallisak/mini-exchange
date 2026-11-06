import { NextRequest, NextResponse } from 'next/server';
import { TokenPair, claimsOf, clearTokens, newSession, sessionsIn, storeTokens } from './session';
import { endForgottenSessions, upstream } from './upstream';

const JSON_BODY = /^application\/json(\s*;|$)/i;

export async function signIn(request: NextRequest, path: '/auth/login' | '/auth/register') {
  if (!JSON_BODY.test(request.headers.get('content-type') ?? '')) {
    return NextResponse.json({ message: 'Send the credentials as JSON' }, { status: 415 });
  }
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
  const session = newSession();
  const forgotten = sessionsIn(request);
  clearTokens(response, forgotten);
  storeTokens(response, tokens, session);
  void endForgottenSessions(request, forgotten);
  return response;
}
