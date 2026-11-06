import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

export const ACCESS_COOKIE = 'mx_access';
export const REFRESH_COOKIE = 'mx_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
export const REFRESH_REUSE_WINDOW_MS = 5_000;
export const ROTATION_RETRY_MS = 10 * 60_000;
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
  | { kind: 'unavailable'; untouched?: boolean };

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

export function readTokens(request: NextRequest): Partial<TokenPair> {
  return {
    accessToken: request.cookies.get(ACCESS_COOKIE)?.value,
    refreshToken: request.cookies.get(REFRESH_COOKIE)?.value,
  };
}

export function storeTokens(response: NextResponse, tokens: TokenPair): void {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(REFRESH_MAX_AGE));
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE));
}

export function clearTokens(response: NextResponse): void {
  response.cookies.set(ACCESS_COOKIE, '', cookieOptions(0));
  response.cookies.set(REFRESH_COOKIE, '', cookieOptions(0));
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
const attempts = new Map<string, string>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  while (map.size >= REMEMBERED_SESSIONS) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

const sessionKey = ({ refreshToken, accessToken, client }: SessionTokens) =>
  JSON.stringify([refreshToken, accessToken ?? '', client ?? '']);

export function refreshOnce(
  tokens: SessionTokens,
  rotate: (token: string, attempt: string) => Promise<Rotation>,
): Promise<Rotation> {
  const key = sessionKey(tokens);
  const pending = refreshes.get(key);
  if (pending) return pending;
  const attempt = attempts.get(key) ?? randomUUID();
  remember(attempts, key, attempt);
  const outcome = rotate(tokens.refreshToken, attempt).catch((): Rotation => ({ kind: 'unavailable' }));
  remember(refreshes, key, outcome);
  void outcome.then((result) => {
    const forget = (map: Map<string, unknown>, value: unknown) => {
      if (map.get(key) === value) map.delete(key);
    };
    if (result.kind === 'invalid' || (result.kind === 'unavailable' && result.untouched)) forget(attempts, attempt);
    else setTimeout(() => forget(attempts, attempt), ROTATION_RETRY_MS).unref?.();
    if (result.kind === 'unavailable') forget(refreshes, outcome);
    else {
      const keep = result.kind === 'invalid' ? INVALID_REMEMBERED_MS : REFRESH_REUSE_WINDOW_MS;
      setTimeout(() => forget(refreshes, outcome), keep).unref?.();
    }
  });
  return outcome;
}
