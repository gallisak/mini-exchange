import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac, hkdfSync } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  REFRESH_REUSE_WINDOW_MS,
  REMEMBERED_SESSIONS,
  Rotation,
  OLD_SESSIONS_PER_REQUEST,
  clearLegacyCookies,
  cookieName,
  legacySessions,
  newSession,
  refreshOnce,
  rememberLegacyDone,
  sessionsIn,
  storeTokens,
} from './session';
import { sessionCookies } from './test-session';

describe('sharing one refresh between requests', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rotated = (n: number): Rotation => ({
    kind: 'rotated',
    tokens: { accessToken: `access-${n}`, refreshToken: `refresh-${n}` },
  });

  it('gives requests that raced the rotation the same new pair', async () => {
    const rotate = vi.fn(async () => rotated(1));

    const [first, second] = await Promise.all([
      refreshOnce({ refreshToken: 'shared-a', accessToken: 'access-a' }, rotate),
      refreshOnce({ refreshToken: 'shared-a', accessToken: 'access-a' }, rotate),
    ]);
    const late = await refreshOnce({ refreshToken: 'shared-a', accessToken: 'access-a' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(1);
    expect([first, second, late]).toEqual([rotated(1), rotated(1), rotated(1)]);
  });

  it('stops handing out the new pair for the old token after a few seconds', async () => {
    let n = 0;
    const rotate = vi.fn(async () => rotated(++n));
    await refreshOnce({ refreshToken: 'shared-b', accessToken: 'access-b' }, rotate);

    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_WINDOW_MS);
    await refreshOnce({ refreshToken: 'shared-b', accessToken: 'access-b' }, rotate);

    expect(REFRESH_REUSE_WINDOW_MS).toBeLessThanOrEqual(5_000);
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('does not hand the new pair to someone who has the old refresh token without its access token', async () => {
    const rotate = vi.fn(async () => rotated(1));
    await refreshOnce({ refreshToken: 'stolen', accessToken: 'access-c' }, rotate);
    await refreshOnce({ refreshToken: 'stolen', accessToken: 'access-c' }, rotate);

    await refreshOnce({ refreshToken: 'stolen' }, rotate);
    await refreshOnce({ refreshToken: 'stolen', accessToken: 'forged' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(3);
  });

  it('does not share a rotation with another client, even when it brings the same cookies', async () => {
    const rotate = vi.fn(async () => rotated(1));

    await refreshOnce({ refreshToken: 'copied', accessToken: 'access-e', client: '203.0.113.5 Firefox' }, rotate);
    await refreshOnce({ refreshToken: 'copied', accessToken: 'access-e', client: '198.51.100.7 curl' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('keeps the attempt of a rotation for a later request that still brings the old cookies', async () => {
    const rotate = vi.fn(async (_token: string, _attempt: string) => rotated(1));
    await refreshOnce({ refreshToken: 'kept', accessToken: 'access-f' }, rotate);

    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_WINDOW_MS + 1_000);
    await refreshOnce({ refreshToken: 'kept', accessToken: 'access-f' }, rotate);

    const [first, second] = rotate.mock.calls.map(([, attempt]) => attempt);
    expect(second).toBe(first);
  });

  it('keeps the attempt of a lost rotation for minutes, not just one', async () => {
    const outcomes: Rotation[] = [{ kind: 'unavailable' }, rotated(1)];
    const rotate = vi.fn(async (_token: string, _attempt: string) => outcomes.shift() as Rotation);
    await refreshOnce({ refreshToken: 'slow', accessToken: 'access-g' }, rotate);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await refreshOnce({ refreshToken: 'slow', accessToken: 'access-g' }, rotate);

    const [first, second] = rotate.mock.calls.map(([, attempt]) => attempt);
    expect(second).toBe(first);
  });

  it('retries a rotation whose answer was lost as the same attempt', async () => {
    const outcomes: Rotation[] = [{ kind: 'unavailable' }, rotated(1)];
    const rotate = vi.fn(async (_token: string, _attempt: string) => outcomes.shift() as Rotation);

    await refreshOnce({ refreshToken: 'lost', accessToken: 'access-d' }, rotate);
    await refreshOnce({ refreshToken: 'lost', accessToken: 'access-d' }, rotate);

    const [first, second] = rotate.mock.calls.map(([, attempt]) => attempt);
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });

  it('keeps the access cookie as long as the refresh cookie, so a refresh can be tied to both', () => {
    const response = NextResponse.json({});

    storeTokens(response, { accessToken: 'a', refreshToken: 'r' }, newSession());

    const ages = response.headers.getSetCookie().map((cookie) => /Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(ages).toEqual(['604800', '604800']);
  });

  it('retries with the same attempt after the engine answered 429, so a used attempt is never replaced', async () => {
    const outcomes: Rotation[] = [{ kind: 'unavailable' }, { kind: 'unavailable' }, rotated(1)];
    const rotate = vi.fn(async (_token: string, _attempt: string) => outcomes.shift() as Rotation);

    for (let n = 0; n < 3; n += 1) await refreshOnce({ refreshToken: 'limited', accessToken: 'access-h' }, rotate);

    expect(new Set(rotate.mock.calls.map(([, attempt]) => attempt)).size).toBe(1);
  });

  it('keeps the attempt of a session however many other sessions rotate meanwhile', async () => {
    const rotate = vi.fn(async (_token: string, _attempt: string): Promise<Rotation> => ({ kind: 'unavailable' }));
    const victim = { refreshToken: 'victim', accessToken: 'access-v', client: 'Firefox' };
    await refreshOnce(victim, rotate);
    const before = rotate.mock.calls.at(-1)?.[1];

    for (let n = 1; n <= REMEMBERED_SESSIONS + 10; n += 1) {
      await refreshOnce({ refreshToken: `flood-${n}`, accessToken: 'flood' }, rotate);
    }
    await refreshOnce(victim, rotate);

    expect(rotate.mock.calls.at(-1)?.[1]).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not ask the engine again for a refresh token it just refused', async () => {
    const rotate = vi.fn(async (): Promise<Rotation> => ({ kind: 'invalid' }));

    await refreshOnce({ refreshToken: 'dead', accessToken: 'access-i' }, rotate);
    await vi.advanceTimersByTimeAsync(30_000);
    await refreshOnce({ refreshToken: 'dead', accessToken: 'access-i' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(1);
  });
});

describe('the key that signs session cookies', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is not made up by a production process that was given none', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_PROXY_KEY', '');
    vi.resetModules();

    const { newSession: signed } = await import('./session');

    expect(() => signed()).toThrow('FRONTEND_PROXY_KEY must be set');
  });

  it('is made up outside production, for a laptop without one', async () => {
    vi.stubEnv('FRONTEND_PROXY_KEY', '');
    vi.resetModules();

    const { newSession: signed } = await import('./session');

    expect(signed()).toMatch(/^[0-9a-z]{36}$/);
  });
});

describe('the keys made from FRONTEND_PROXY_KEY', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const madeFrom = async (key: string) => {
    vi.stubEnv('FRONTEND_PROXY_KEY', key);
    vi.resetModules();
    return import('./session');
  };

  it('give the services a key of their own, not the key itself', async () => {
    const { proxyKey } = await madeFrom('proxy-key');

    expect(proxyKey()).toBe('45b3e07d034673b9e8bfa1e6e415e26a669844bdce1b7493ebe33c82d094cc76');
    expect(proxyKey()).not.toBe(Buffer.from('proxy-key').toString('hex'));
  });

  it('sign cookies with a key made for them, neither the key itself nor the one the services get', async () => {
    const { newSession: signed, proxyKey, signedValue } = await madeFrom('proxy-key');
    const session = signed();
    const token = 'a.b.c';
    const signedWith = (key: string | Buffer) =>
      `${token}~${createHmac('sha256', key)
        .update(`session:${session}:${createHash('sha256').update(token).digest('hex')}`)
        .digest('hex')
        .slice(0, 32)}`;

    expect(signedValue(session, token)).toBe(signedWith(Buffer.from(hkdfSync('sha256', 'proxy-key', '', 'mx-cookie-signing', 32))));
    expect(signedValue(session, token)).not.toBe(signedWith('proxy-key'));
    expect(signedValue(session, token)).not.toBe(signedWith(Buffer.from(proxyKey(), 'hex')));
  });
});

describe('reading the cookies of a request', () => {
  const carrying = (cookie: string) => new NextRequest('http://exchange.test/api/wallet', { headers: { cookie } });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a session whose values were signed for its name', () => {
    const session = newSession();

    expect(sessionsIn(carrying(sessionCookies('access', 'refresh', session)))).toEqual(
      new Map([[session, { accessToken: 'access', refreshToken: 'refresh' }]]),
    );
  });

  it('ignores a cookie with a genuine id but a value of someone else', () => {
    const session = newSession();
    const other = newSession();
    const [access, refresh] = sessionCookies('attacker-access', 'attacker-refresh', other)
      .split('; ')
      .map((cookie) => cookie.split('=')[1]);

    const cookie = `${cookieName(ACCESS_COOKIE, session)}=${access}; ${cookieName(REFRESH_COOKIE, session)}=${refresh}`;

    expect(sessionsIn(carrying(cookie))).toEqual(new Map());
  });

  it('ignores a cookie with a genuine id but an unsigned value', () => {
    const session = newSession();

    expect(sessionsIn(carrying(`${cookieName(ACCESS_COOKIE, session)}=unsigned`))).toEqual(new Map());
  });

  it('finds cookies of every older format, and leaves the current ones alone', () => {
    const session = newSession();
    const before = newSession();
    const cookie = [
      sessionCookies('access', 'refresh', session),
      'mx_access=bare.access.token',
      'mx_refresh=bare.refresh.token',
      'mx_refresh_abcdefghij0123456789=short.refresh.token',
      `${cookieName(REFRESH_COOKIE, before)}=unsigned.refresh.token`,
    ].join('; ');

    const found = legacySessions(carrying(cookie)).sessions;

    expect(found.map(({ refreshToken }) => refreshToken).sort()).toEqual([
      'bare.refresh.token',
      'short.refresh.token',
      'unsigned.refresh.token',
    ]);
    expect(found.find(({ refreshToken }) => refreshToken === 'bare.refresh.token')?.names.sort()).toEqual([
      'mx_access',
      'mx_refresh',
    ]);
  });

  it('takes names without the prefix for old ones once cookies are secure, and sends their token without its signature', () => {
    const plain = newSession();
    const cookie = sessionCookies('old.access.token', 'old.refresh.token', plain);
    vi.stubEnv('COOKIE_SECURE', 'true');

    expect(legacySessions(carrying(cookie)).sessions).toEqual([
      {
        names: expect.arrayContaining([`mx_refresh_${plain}`, `mx_access_${plain}`]),
        marks: [expect.any(String), expect.any(String)],
        refreshToken: 'old.refresh.token',
        accessToken: 'old.access.token',
      },
    ]);
  });

  it('keeps the access token of an old session whose refresh cookie is gone, so that session can still be ended', () => {
    expect(legacySessions(carrying('mx_access=bare.access.token')).sessions).toEqual([
      { names: ['mx_access'], marks: [expect.any(String)], accessToken: 'bare.access.token' },
    ]);
  });

  it('takes only the exact names older versions used, not any name that starts the same way', () => {
    const cookie = ['mx_refresh_x=a.b.c', 'mx_refresh_ABCDEFGHIJ0123456789=a.b.c', `mx_refresh_${'a'.repeat(21)}=a.b.c`, 'mx_refreshes=a.b.c'].join('; ');

    expect(legacySessions(carrying(cookie))).toEqual({ sessions: [], tokenless: [], more: false });
  });

  it('takes a few old sessions per request, however many cookies were planted, and says more are left', () => {
    const cookie = Array.from({ length: 12 }, (_, n) => `mx_refresh_${String(n).padStart(20, '0')}=a.b.c`).join('; ');

    const found = legacySessions(carrying(cookie));

    expect(found.sessions).toHaveLength(OLD_SESSIONS_PER_REQUEST);
    expect(found.more).toBe(true);
  });

  it('does not let cookies without a token take the places of old sessions that have one', () => {
    const planted = Array.from({ length: 6 }, (_, n) => `mx_refresh_${String(n).padStart(20, '0')}=not-a-token`);
    const cookie = [...planted, 'mx_refresh=real.refresh.token'].join('; ');

    const found = legacySessions(carrying(cookie));

    expect(found.sessions.map(({ refreshToken }) => refreshToken)).toEqual(['real.refresh.token']);
    expect(found.tokenless).toHaveLength(6);
    expect(found.more).toBe(false);
  });

  it('sends no value that is not a token, and still lets its cookie be cleared', () => {
    expect(legacySessions(carrying('mx_refresh=not-a-token'))).toEqual({
      sessions: [],
      tokenless: [{ names: ['mx_refresh'], marks: [expect.any(String)] }],
      more: false,
    });
  });

  it('remembers old cookies it already dealt with, so a cookie that cannot be cleared is not ended on every check', () => {
    const cookie = 'mx_refresh=old.refresh.token; mx_access_abcdefghij0123456789=not-a-token';
    const first = legacySessions(carrying(cookie));
    const response = NextResponse.json({});

    rememberLegacyDone(carrying(cookie), response, [...first.sessions, ...first.tokenless].flatMap(({ marks }) => marks), new Map());
    const done = response.headers.getSetCookie()[0].split(';')[0];

    expect(legacySessions(carrying(`${cookie}; ${done}`))).toEqual({ sessions: [], tokenless: [], more: false });
    expect(legacySessions(carrying(`mx_refresh=another.refresh.token; ${done}`)).sessions).toHaveLength(1);
  });

  it('takes no note it did not sign, so a planted note cannot hide an old session', () => {
    const cookie = 'mx_refresh=old.refresh.token';
    const response = NextResponse.json({});
    rememberLegacyDone(carrying(cookie), response, legacySessions(carrying(cookie)).sessions[0].marks, new Map());
    const [list] = response.headers.getSetCookie()[0].split(';')[0].split('=')[1].split('~');

    expect(legacySessions(carrying(`${cookie}; mx_legacy_done=${list}~${'0'.repeat(32)}`)).sessions).toHaveLength(1);
  });

  it('forgets a note about an old cookie the browser no longer sends', () => {
    const cookie = 'mx_refresh=old.refresh.token';
    const noted = NextResponse.json({});
    rememberLegacyDone(carrying(cookie), noted, legacySessions(carrying(cookie)).sessions[0].marks, new Map());
    const done = noted.headers.getSetCookie()[0].split(';')[0];
    const response = NextResponse.json({});

    rememberLegacyDone(carrying(done), response, [], new Map());

    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^mx_legacy_done=;.*Max-Age=0/)]);
  });

  it('keeps the old cookies it cleared when a session cookie is written after them, whatever the order', () => {
    const response = NextResponse.json({});

    clearLegacyCookies(response, ['mx_refresh']);
    storeTokens(response, { accessToken: 'a', refreshToken: 'r' }, newSession());

    const cookies = response.headers.getSetCookie();
    expect(cookies.filter((cookie) => cookie.startsWith('mx_refresh='))).toHaveLength(2);
    expect(cookies.filter((cookie) => /^mx_(access|refresh)_/.test(cookie))).toHaveLength(2);
  });

  it('clears an old cookie on both paths, and one with the prefix the only way a browser accepts', () => {
    const response = NextResponse.json({});

    clearLegacyCookies(response, ['mx_refresh', '__Host-mx_refresh_x']);

    const cookies = response.headers.getSetCookie();
    expect(cookies.filter((cookie) => cookie.startsWith('mx_refresh=')).map((cookie) => /Path=([^;]*)/.exec(cookie)?.[1])).toEqual([
      '/',
      '/api',
    ]);
    const prefixed = cookies.filter((cookie) => cookie.startsWith('__Host-'));
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]).toMatch(/Path=\/; Secure/);
  });
});
