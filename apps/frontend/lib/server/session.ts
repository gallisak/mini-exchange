import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

export const ACCESS_COOKIE = 'mx_access';
export const REFRESH_COOKIE = 'mx_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
export const REFRESH_REUSE_WINDOW_MS = 5_000;
export const REMEMBERED_SESSIONS = 10_000;
const INVALID_REMEMBERED_MS = 60_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface SessionTokens {
  refreshToken: string;
  accessToken?: string;
  client?: string;
}

export type Rotation =
  | { kind: 'rotated'; tokens: TokenPair }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

export interface SessionUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

const secureCookies = () => process.env.COOKIE_SECURE === 'true';

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: secureCookies(),
  path: '/',
  maxAge,
});

const SESSION_COOKIE = /^mx_(?:access|refresh)_([0-9a-z]{20}[0-9a-f]{16})$/;

const cookiePrefix = () => (secureCookies() ? '__Host-' : '');

export const cookieName = (base: string, session: string) => `${cookiePrefix()}${base}_${session}`;

const fallbackKey = randomBytes(32);

const signature = (id: string) =>
  createHmac('sha256', process.env.FRONTEND_PROXY_KEY || fallbackKey)
    .update(`session:${id}`)
    .digest('hex')
    .slice(0, 16);

function isGenuine(session: string): boolean {
  const expected = Buffer.from(signature(session.slice(0, 20)));
  const given = Buffer.from(session.slice(20));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function newSession(): string {
  const id = `${Date.now().toString(36).padStart(10, '0')}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  return `${id}${signature(id)}`;
}

export function sessionsIn(request: NextRequest): string[] {
  const prefix = cookiePrefix();
  const sessions = new Set<string>();
  for (const { name } of request.cookies.getAll()) {
    if (!name.startsWith(prefix)) continue;
    const session = SESSION_COOKIE.exec(name.slice(prefix.length))?.[1];
    if (session && isGenuine(session)) sessions.add(session);
  }
  return [...sessions].sort();
}

export function readTokens(request: NextRequest): Partial<TokenPair> & { session: string } {
  const session = sessionsIn(request).at(-1);
  if (!session) return { session: '' };
  return {
    session,
    accessToken: request.cookies.get(cookieName(ACCESS_COOKIE, session))?.value || undefined,
    refreshToken: request.cookies.get(cookieName(REFRESH_COOKIE, session))?.value || undefined,
  };
}

export function refreshTokenOf(request: NextRequest, session: string): string | undefined {
  return request.cookies.get(cookieName(REFRESH_COOKIE, session))?.value || undefined;
}

export function storeTokens(response: NextResponse, tokens: TokenPair, session: string): void {
  response.cookies.set(cookieName(ACCESS_COOKIE, session), tokens.accessToken, cookieOptions(REFRESH_MAX_AGE));
  response.cookies.set(cookieName(REFRESH_COOKIE, session), tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));
}

export function clearTokens(response: NextResponse, sessions: string[]): void {
  for (const session of sessions.filter(Boolean)) {
    response.cookies.set(cookieName(ACCESS_COOKIE, session), '', cookieOptions(0));
    response.cookies.set(cookieName(REFRESH_COOKIE, session), '', cookieOptions(0));
  }
}

export function olderSessions(request: NextRequest, current: string): string[] {
  return sessionsIn(request).filter((session) => session < current);
}

export function claimsOf(token: string | undefined): (SessionUser & { exp: number }) | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role === 'admin' ? 'admin' : 'user',
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

export function isFresh(token: string | undefined): token is string {
  const claims = claimsOf(token);
  return claims !== null && claims.exp * 1000 > Date.now() + 5_000;
}

const refreshes = new Map<string, Promise<Rotation>>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  while (map.size >= REMEMBERED_SESSIONS) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

const sessionKey = ({ refreshToken, accessToken, client }: SessionTokens) =>
  JSON.stringify([refreshToken, accessToken ?? '', client ?? '']);

export function rotationAttempt(tokens: SessionTokens): string {
  const secret = process.env.FRONTEND_PROXY_KEY || fallbackKey;
  const digest = createHmac('sha256', secret).update(`rotation:${sessionKey(tokens)}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function refreshOnce(
  tokens: SessionTokens,
  rotate: (token: string, attempt: string) => Promise<Rotation>,
): Promise<Rotation> {
  const key = sessionKey(tokens);
  const pending = refreshes.get(key);
  if (pending) return pending;
  const outcome = rotate(tokens.refreshToken, rotationAttempt(tokens)).catch(
    (): Rotation => ({ kind: 'unavailable' }),
  );
  remember(refreshes, key, outcome);
  void outcome.then((result) => {
    const forget = () => {
      if (refreshes.get(key) === outcome) refreshes.delete(key);
    };
    if (result.kind === 'unavailable') forget();
    else setTimeout(forget, result.kind === 'invalid' ? INVALID_REMEMBERED_MS : REFRESH_REUSE_WINDOW_MS).unref?.();
  });
  return outcome;
}
