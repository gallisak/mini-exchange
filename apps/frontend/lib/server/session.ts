import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_HEADER } from '@/lib/session-id';

export const ACCESS_COOKIE = 'mx_access';
export const REFRESH_COOKIE = 'mx_refresh';
const ENDING_COOKIE = 'mx_ending';
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
  path: secureCookies() ? '/' : '/api',
  maxAge,
});

const SESSION_COOKIE = /^mx_(?:access|refresh)_([0-9a-z]{20}[0-9a-f]{16})$/;
const ANY_SESSION_COOKIE = /^((?:__Host-)?mx_)(access|refresh)((?:_[0-9a-z]+)?)$/;
const VALUE_SEPARATOR = '~';

const cookiePrefix = () => (secureCookies() ? '__Host-' : '');

export const cookieName = (base: string, session: string) => `${cookiePrefix()}${base}_${session}`;

const endingCookie = () => `${cookiePrefix()}${ENDING_COOKIE}`;

const fallbackKey = process.env.NODE_ENV === 'production' ? null : randomBytes(32);

function signingKey(): string | Buffer {
  const key = process.env.FRONTEND_PROXY_KEY || fallbackKey;
  if (!key) throw new Error('FRONTEND_PROXY_KEY must be set');
  return key;
}

const hmac = (label: string, data: string) =>
  createHmac('sha256', signingKey()).update(`${label}:${data}`).digest('hex');

const signature = (id: string) => hmac('session', id).slice(0, 16);

const valueSignature = (session: string, token: string) =>
  hmac('session', `${session}:${createHash('sha256').update(token).digest('hex')}`).slice(0, 32);

const endingSignature = (list: string) => hmac('ending', list).slice(0, 32);

const sameText = (given: string, expected: string) => {
  const [a, b] = [Buffer.from(given), Buffer.from(expected)];
  return a.length === b.length && timingSafeEqual(a, b);
};

const isGenuine = (session: string) => sameText(session.slice(20), signature(session.slice(0, 20)));

export const signedValue = (session: string, token: string) =>
  `${token}${VALUE_SEPARATOR}${valueSignature(session, token)}`;

function tokenIn(session: string, value: string | undefined): string | undefined {
  const separator = value?.lastIndexOf(VALUE_SEPARATOR) ?? -1;
  if (!value || separator <= 0) return undefined;
  const token = value.slice(0, separator);
  return sameText(value.slice(separator + 1), valueSignature(session, token)) ? token : undefined;
}

export function newSession(): string {
  const id = `${Date.now().toString(36).padStart(10, '0')}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  return `${id}${signature(id)}`;
}

export function sessionsIn(request: NextRequest): string[] {
  const prefix = cookiePrefix();
  const named = new Set<string>();
  for (const { name } of request.cookies.getAll()) {
    if (!name.startsWith(prefix)) continue;
    const session = SESSION_COOKIE.exec(name.slice(prefix.length))?.[1];
    if (session) named.add(session);
  }
  return [...named]
    .filter((session) => {
      if (!isGenuine(session)) return false;
      const { accessToken, refreshToken } = tokensOf(request, session);
      return Boolean(accessToken || refreshToken);
    })
    .sort();
}

export function tokensOf(request: NextRequest, session: string): Partial<TokenPair> {
  return {
    accessToken: tokenIn(session, request.cookies.get(cookieName(ACCESS_COOKIE, session))?.value),
    refreshToken: tokenIn(session, request.cookies.get(cookieName(REFRESH_COOKIE, session))?.value),
  };
}

export function readTokens(
  request: NextRequest,
  sessions: string[] = sessionsIn(request),
): Partial<TokenPair> & { session: string } {
  const asked = request.headers.get(SESSION_HEADER);
  const session = asked && sessions.includes(asked) ? asked : sessions.at(-1);
  return session ? { session, ...tokensOf(request, session) } : { session: '' };
}

export function askedForAnother(request: NextRequest, session: string): boolean {
  const asked = request.headers.get(SESSION_HEADER);
  return Boolean(asked && session) && asked !== session;
}

export function storeTokens(response: NextResponse, tokens: TokenPair, session: string): void {
  const stored = (token: string) => signedValue(session, token);
  response.cookies.set(cookieName(ACCESS_COOKIE, session), stored(tokens.accessToken), cookieOptions(REFRESH_MAX_AGE));
  response.cookies.set(cookieName(REFRESH_COOKIE, session), stored(tokens.refreshToken), cookieOptions(REFRESH_MAX_AGE));
}

export function clearTokens(response: NextResponse, sessions: string[]): void {
  for (const session of sessions.filter(Boolean)) {
    response.cookies.set(cookieName(ACCESS_COOKIE, session), '', cookieOptions(0));
    response.cookies.set(cookieName(REFRESH_COOKIE, session), '', cookieOptions(0));
  }
}

export function endingIn(request: NextRequest, sessions: string[]): string[] {
  const [list, signed] = (request.cookies.get(endingCookie())?.value ?? '').split(VALUE_SEPARATOR);
  if (!list || !signed || !sameText(signed, endingSignature(list))) return [];
  const listed = list.split('.');
  return sessions.filter((session) => listed.includes(session));
}

export function rememberEnding(request: NextRequest, response: NextResponse, sessions: string[]): void {
  const list = sessions.join('.');
  if (list) {
    response.cookies.set(endingCookie(), `${list}${VALUE_SEPARATOR}${endingSignature(list)}`, cookieOptions(REFRESH_MAX_AGE));
  } else if (request.cookies.has(endingCookie())) {
    response.cookies.set(endingCookie(), '', cookieOptions(0));
  }
}

export function olderSessions(sessions: string[], current: string): string[] {
  return sessions.filter((session) => session < current);
}

export interface LegacySession {
  names: string[];
  refreshToken?: string;
}

export function legacySessions(request: NextRequest, sessions: string[] = sessionsIn(request)): LegacySession[] {
  const current = new Set(
    sessions.flatMap((session) => [cookieName(ACCESS_COOKIE, session), cookieName(REFRESH_COOKIE, session)]),
  );
  const found = new Map<string, LegacySession>();
  for (const { name, value } of request.cookies.getAll()) {
    const parts = ANY_SESSION_COOKIE.exec(name);
    if (!parts || current.has(name)) continue;
    const [, prefix, kind, suffix] = parts;
    const legacy = found.get(prefix + suffix) ?? { names: [] };
    legacy.names.push(name);
    if (kind === 'refresh' && value) legacy.refreshToken = value.split(VALUE_SEPARATOR)[0];
    found.set(prefix + suffix, legacy);
  }
  return [...found.values()];
}

export function clearLegacyCookies(response: NextResponse, names: string[]): void {
  const secure = secureCookies() ? '; Secure' : '';
  for (const name of names) {
    const expired = `${name}=; Max-Age=0; HttpOnly; SameSite=Lax`;
    if (name.startsWith('__Host-')) {
      response.headers.append('set-cookie', `${expired}; Path=/; Secure`);
      continue;
    }
    response.headers.append('set-cookie', `${expired}; Path=/${secure}`);
    response.headers.append('set-cookie', `${expired}; Path=/api${secure}`);
  }
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
  const digest = hmac('rotation', sessionKey(tokens));
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
