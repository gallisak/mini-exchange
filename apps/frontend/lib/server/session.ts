import { createHmac, randomBytes, randomUUID } from 'crypto';
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

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/api',
  maxAge,
});

const SESSION_COOKIE = /^mx_(?:access|refresh)(?:_([0-9a-z]{1,40}))?$/;

const cookieName = (base: string, session: string) => (session ? `${base}_${session}` : base);

export function newSession(): string {
  return `${Date.now().toString(36).padStart(10, '0')}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function sessionsIn(request: NextRequest): string[] {
  const sessions = new Set<string>();
  for (const { name } of request.cookies.getAll()) {
    const match = SESSION_COOKIE.exec(name);
    if (match) sessions.add(match[1] ?? '');
  }
  return [...sessions].sort();
}

export function readTokens(request: NextRequest): Partial<TokenPair> & { session: string } {
  const session = sessionsIn(request).at(-1) ?? '';
  return {
    session,
    accessToken: request.cookies.get(cookieName(ACCESS_COOKIE, session))?.value || undefined,
    refreshToken: request.cookies.get(cookieName(REFRESH_COOKIE, session))?.value || undefined,
  };
}

export function storeTokens(response: NextResponse, tokens: TokenPair, session = ''): void {
  response.cookies.set(cookieName(ACCESS_COOKIE, session), tokens.accessToken, cookieOptions(REFRESH_MAX_AGE));
  response.cookies.set(cookieName(REFRESH_COOKIE, session), tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));
}

export function clearTokens(response: NextResponse, sessions: string[]): void {
  for (const session of sessions) {
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
const fallbackKey = randomBytes(32);

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
