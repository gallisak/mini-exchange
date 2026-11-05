import { NextRequest, NextResponse } from 'next/server';

export const ACCESS_COOKIE = 'mx_access';
export const REFRESH_COOKIE = 'mx_refresh';
const ACCESS_MAX_AGE = 15 * 60;
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
export const REFRESH_REUSE_WINDOW_MS = 5_000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
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

export function readTokens(request: NextRequest): Partial<TokenPair> {
  return {
    accessToken: request.cookies.get(ACCESS_COOKIE)?.value,
    refreshToken: request.cookies.get(REFRESH_COOKIE)?.value,
  };
}

export function storeTokens(response: NextResponse, tokens: TokenPair): void {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(ACCESS_MAX_AGE));
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

export function refreshOnce(
  refreshToken: string,
  rotate: (token: string) => Promise<Rotation>,
): Promise<Rotation> {
  const pending = refreshes.get(refreshToken);
  if (pending) return pending;
  const attempt = rotate(refreshToken).catch((): Rotation => ({ kind: 'unavailable' }));
  refreshes.set(refreshToken, attempt);
  void attempt.then((outcome) => {
    if (outcome.kind === 'unavailable') {
      refreshes.delete(refreshToken);
      return;
    }
    setTimeout(() => refreshes.delete(refreshToken), REFRESH_REUSE_WINDOW_MS).unref?.();
  });
  return attempt;
}
