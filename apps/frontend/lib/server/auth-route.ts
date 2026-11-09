import { NextRequest, NextResponse } from 'next/server';
import { TokenPair, claimsOf, clearLegacyCookies, clearTokens, newSession, rememberEnding, sessionsIn, storeTokens } from './session';
import { endLegacySessions, endSessions, upstream } from './upstream';

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
  const session = newSession();
  const response = NextResponse.json({
    user: claims && { id: claims.id, email: claims.email, role: claims.role },
    session,
  });
  storeTokens(response, tokens, session);
  const forgotten = sessionsIn(request);
  const [ended, legacy] = await Promise.all([endSessions(request, forgotten), endLegacySessions(request, forgotten)]);
  clearTokens(response, ended);
  rememberEnding(request, response, forgotten.filter((id) => !ended.includes(id)));
  clearLegacyCookies(response, legacy.names);
  return response;
}
