import { createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_HEADER } from '@/lib/session-id';

export const ACCESS_COOKIE = 'mx_access';
export const REFRESH_COOKIE = 'mx_refresh';
const ENDING_COOKIE = 'mx_ending';
const LEGACY_DONE_COOKIE = 'mx_legacy_done';
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

export type Sessions = Map<string, Partial<TokenPair>>;

export interface SessionUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

const secureCookies = () => process.env.COOKIE_SECURE === 'true';

function writeCookie(response: NextResponse, name: string, value: string, maxAge: number): void {
  const attributes = `Path=${secureCookies() ? '/' : '/api'}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
  response.headers.append('set-cookie', `${name}=${value}; ${attributes}${secureCookies() ? '; Secure' : ''}`);
}

const SESSION_COOKIE = /^mx_(?:access|refresh)_([0-9a-z]{20}[0-9a-f]{16})$/;
const OLD_SESSION_COOKIE = /^((?:__Host-)?mx_)(access|refresh)((?:_[0-9a-z]{20}(?:[0-9a-f]{16})?)?)$/;
const TOKEN_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
export const OLD_SESSIONS_PER_REQUEST = 4;
const VALUE_SEPARATOR = '~';

const cookiePrefix = () => (secureCookies() ? '__Host-' : '');

export const cookieName = (base: string, session: string) => `${cookiePrefix()}${base}_${session}`;

const endingCookie = () => `${cookiePrefix()}${ENDING_COOKIE}`;

const legacyDoneCookie = () => `${cookiePrefix()}${LEGACY_DONE_COOKIE}`;

const fallbackKey = process.env.NODE_ENV === 'production' ? null : randomBytes(32);

function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}

const derived = (key: string | Buffer, purpose: string) => Buffer.from(hkdfSync('sha256', key, '', purpose, 32));

const cookieSigningKey = once(() => {
  const key = process.env.FRONTEND_PROXY_KEY || fallbackKey;
  if (!key) throw new Error('FRONTEND_PROXY_KEY must be set');
  return derived(key, 'mx-cookie-signing');
});

export const proxyKey = once(() => derived(process.env.FRONTEND_PROXY_KEY ?? '', 'mx-proxy').toString('hex'));

const hmac = (label: string, data: string) =>
  createHmac('sha256', cookieSigningKey()).update(`${label}:${data}`).digest('hex');

const signature = (id: string) => hmac('session', id).slice(0, 16);

const valueSignature = (session: string, token: string) =>
  hmac('session', `${session}:${createHash('sha256').update(token).digest('hex')}`).slice(0, 32);

const endingSignature = (list: string) => hmac('ending', list).slice(0, 32);

const legacyDoneSignature = (list: string) => hmac('legacy-done', list).slice(0, 32);

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

export function sessionsIn(request: NextRequest): Sessions {
  const prefix = cookiePrefix();
  const named = new Set<string>();
  for (const { name } of request.cookies.getAll()) {
    if (!name.startsWith(prefix)) continue;
    const session = SESSION_COOKIE.exec(name.slice(prefix.length))?.[1];
    if (session) named.add(session);
  }
  const sessions: Sessions = new Map();
  for (const session of [...named].sort()) {
    if (!isGenuine(session)) continue;
    const tokens = tokensOf(request, session);
    if (tokens.accessToken || tokens.refreshToken) sessions.set(session, tokens);
  }
  return sessions;
}

function tokensOf(request: NextRequest, session: string): Partial<TokenPair> {
  return {
    accessToken: tokenIn(session, request.cookies.get(cookieName(ACCESS_COOKIE, session))?.value),
    refreshToken: tokenIn(session, request.cookies.get(cookieName(REFRESH_COOKIE, session))?.value),
  };
}

const usableOf = (sessions: Sessions, ending: string[]) => [...sessions.keys()].filter((session) => !ending.includes(session));

export function readTokens(
  request: NextRequest,
  sessions: Sessions = sessionsIn(request),
  ending: string[] = endingIn(request, sessions),
): Partial<TokenPair> & { session: string } {
  const usable = usableOf(sessions, ending);
  const asked = request.headers.get(SESSION_HEADER);
  const session = asked ? (usable.includes(asked) ? asked : undefined) : usable.at(-1);
  return session ? { session, ...sessions.get(session) } : { session: '' };
}

export function askedForAnother(request: NextRequest, sessions: Sessions, ending: string[]): boolean {
  const asked = request.headers.get(SESSION_HEADER);
  if (!asked) return false;
  const usable = usableOf(sessions, ending);
  return !usable.includes(asked) && usable.length > 0;
}

const endingSessions = new Map<string, true>();

export function noteEnding(sessions: string[]): void {
  for (const session of sessions.filter(Boolean)) remember(endingSessions, session, true);
}

export function isEnding(session: string): boolean {
  return Boolean(session) && endingSessions.has(session);
}

const rotatedPairs = new Map<string, true>();

const pairKey = (accessToken: string) => createHash('sha256').update(accessToken).digest('hex');

export function noteRotated(tokens: TokenPair): void {
  remember(rotatedPairs, pairKey(tokens.accessToken), true);
}

export function rotatedElsewhere(accessToken: string): boolean {
  return rotatedPairs.has(pairKey(accessToken));
}

export function storeTokens(response: NextResponse, tokens: TokenPair, session: string): void {
  if (isEnding(session)) return;
  const stored = (token: string) => signedValue(session, token);
  writeCookie(response, cookieName(ACCESS_COOKIE, session), stored(tokens.accessToken), REFRESH_MAX_AGE);
  writeCookie(response, cookieName(REFRESH_COOKIE, session), stored(tokens.refreshToken), REFRESH_MAX_AGE);
}

export function clearTokens(response: NextResponse, sessions: string[]): void {
  for (const session of sessions.filter(Boolean)) {
    writeCookie(response, cookieName(ACCESS_COOKIE, session), '', 0);
    writeCookie(response, cookieName(REFRESH_COOKIE, session), '', 0);
  }
}

export function endingIn(request: NextRequest, sessions: Sessions): string[] {
  const [list, signed] = (request.cookies.get(endingCookie())?.value ?? '').split(VALUE_SEPARATOR);
  if (!list || !signed || !sameText(signed, endingSignature(list))) return [];
  const listed = list.split('.');
  return [...sessions.keys()].filter((session) => listed.includes(session));
}

export function rememberEnding(request: NextRequest, response: NextResponse, sessions: string[]): void {
  noteEnding(sessions);
  const list = sessions.filter(Boolean).join('.');
  if (list) {
    writeCookie(response, endingCookie(), `${list}${VALUE_SEPARATOR}${endingSignature(list)}`, REFRESH_MAX_AGE);
  } else if (request.cookies.has(endingCookie())) {
    writeCookie(response, endingCookie(), '', 0);
  }
}

export interface LegacySession {
  names: string[];
  marks: string[];
  refreshToken?: string;
  accessToken?: string;
}

export interface LegacyCookies {
  sessions: LegacySession[];
  tokenless: LegacySession[];
  more: boolean;
}

const legacyMark = (name: string, value: string) =>
  createHash('sha256').update(`${name}=${value}`).digest('hex').slice(0, 16);

function legacyDoneIn(request: NextRequest): string[] {
  const [list, signed] = (request.cookies.get(legacyDoneCookie())?.value ?? '').split(VALUE_SEPARATOR);
  if (!list || !signed || !sameText(signed, legacyDoneSignature(list))) return [];
  return list.split('.');
}

function oldCookies(request: NextRequest, sessions: Sessions) {
  const current = new Set(
    [...sessions.keys()].flatMap((session) => [cookieName(ACCESS_COOKIE, session), cookieName(REFRESH_COOKIE, session)]),
  );
  return request.cookies
    .getAll()
    .flatMap(({ name, value }) => {
      const parts = OLD_SESSION_COOKIE.exec(name);
      return parts && !current.has(name) ? [{ name, value, parts, mark: legacyMark(name, value) }] : [];
    });
}

export function legacySessions(request: NextRequest, sessions: Sessions = sessionsIn(request)): LegacyCookies {
  const done = new Set(legacyDoneIn(request));
  const found = new Map<string, LegacySession>();
  for (const { name, value, parts, mark } of oldCookies(request, sessions)) {
    if (done.has(mark)) continue;
    const [, prefix, kind, suffix] = parts;
    const entry = found.get(prefix + suffix) ?? { names: [], marks: [] };
    entry.names.push(name);
    entry.marks.push(mark);
    const token = value.split(VALUE_SEPARATOR)[0];
    if (TOKEN_SHAPE.test(token)) entry[kind === 'refresh' ? 'refreshToken' : 'accessToken'] = token;
    found.set(prefix + suffix, entry);
  }
  const all = [...found.values()];
  const withToken = all.filter(({ refreshToken, accessToken }) => refreshToken || accessToken);
  return {
    sessions: withToken.slice(0, OLD_SESSIONS_PER_REQUEST),
    tokenless: all.filter((entry) => !withToken.includes(entry)),
    more: withToken.length > OLD_SESSIONS_PER_REQUEST,
  };
}

export function rememberLegacyDone(request: NextRequest, response: NextResponse, marks: string[], sessions: Sessions): void {
  const before = legacyDoneIn(request);
  const present = new Set(oldCookies(request, sessions).map(({ mark }) => mark));
  const list = [...new Set([...before, ...marks])].filter((mark) => present.has(mark)).join('.');
  if (list === before.join('.')) return;
  if (list) {
    writeCookie(response, legacyDoneCookie(), `${list}${VALUE_SEPARATOR}${legacyDoneSignature(list)}`, REFRESH_MAX_AGE);
  } else {
    writeCookie(response, legacyDoneCookie(), '', 0);
  }
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
