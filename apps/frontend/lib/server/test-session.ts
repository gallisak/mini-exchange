import { ACCESS_COOKIE, REFRESH_COOKIE, cookieName, newSession, signedValue } from './session';

export function sessionCookies(access: string, refresh?: string, session = newSession()): string {
  const cookies = [`${cookieName(ACCESS_COOKIE, session)}=${signedValue(session, access)}`];
  if (refresh !== undefined) cookies.push(`${cookieName(REFRESH_COOKIE, session)}=${signedValue(session, refresh)}`);
  return cookies.join('; ');
}
