import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieName, newSession, rememberEnding, signedValue } from './session';

export function sessionCookies(access: string, refresh?: string, session = newSession()): string {
  const cookies = [`${cookieName(ACCESS_COOKIE, session)}=${signedValue(session, access)}`];
  if (refresh !== undefined) cookies.push(`${cookieName(REFRESH_COOKIE, session)}=${signedValue(session, refresh)}`);
  return cookies.join('; ');
}

export function endingNote(sessions: string[]): string {
  const response = NextResponse.json({});
  rememberEnding(new NextRequest('http://exchange.test/'), response, sessions);
  return response.headers.getSetCookie()[0].split(';')[0];
}
