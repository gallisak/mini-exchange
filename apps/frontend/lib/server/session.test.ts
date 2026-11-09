import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  derivedKey,
  legacySessions,
  newSession,
  refreshOnce,
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
  it('give cookies and the services keys of their own, neither of them the key itself', () => {
    const cookies = derivedKey('proxy-key', 'mx-cookie-signing');
    const proxy = derivedKey('proxy-key', 'mx-proxy');

    expect(cookies.equals(proxy)).toBe(false);
    expect(cookies.equals(Buffer.from('proxy-key'))).toBe(false);
    expect(proxy.toString('hex')).toBe('45b3e07d034673b9e8bfa1e6e415e26a669844bdce1b7493ebe33c82d094cc76');
  });
});

describe('reading the cookies of a request', () => {
  const carrying = (cookie: string) => new NextRequest('http://exchange.test/api/wallet', { headers: { cookie } });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a session whose values were signed for its name', () => {
    const session = newSession();

    expect(sessionsIn(carrying(sessionCookies('access', 'refresh', session)))).toEqual([session]);
  });

  it('ignores a cookie with a genuine id but a value of someone else', () => {
    const session = newSession();
    const other = newSession();
    const [access, refresh] = sessionCookies('attacker-access', 'attacker-refresh', other)
      .split('; ')
      .map((cookie) => cookie.split('=')[1]);

    const cookie = `${cookieName(ACCESS_COOKIE, session)}=${access}; ${cookieName(REFRESH_COOKIE, session)}=${refresh}`;

    expect(sessionsIn(carrying(cookie))).toEqual([]);
  });

  it('ignores a cookie with a genuine id but an unsigned value', () => {
    const session = newSession();

    expect(sessionsIn(carrying(`${cookieName(ACCESS_COOKIE, session)}=unsigned`))).toEqual([]);
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

    const found = legacySessions(carrying(cookie));

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

    expect(legacySessions(carrying(cookie))).toEqual([
      {
        names: expect.arrayContaining([`mx_refresh_${plain}`, `mx_access_${plain}`]),
        refreshToken: 'old.refresh.token',
        accessToken: 'old.access.token',
      },
    ]);
  });

  it('keeps the access token of an old session whose refresh cookie is gone, so that session can still be ended', () => {
    expect(legacySessions(carrying('mx_access=bare.access.token'))).toEqual([
      { names: ['mx_access'], accessToken: 'bare.access.token' },
    ]);
  });

  it('takes only the exact names older versions used, not any name that starts the same way', () => {
    const cookie = ['mx_refresh_x=a.b.c', 'mx_refresh_ABCDEFGHIJ0123456789=a.b.c', `mx_refresh_${'a'.repeat(21)}=a.b.c`, 'mx_refreshes=a.b.c'].join('; ');

    expect(legacySessions(carrying(cookie))).toEqual([]);
  });

  it('takes a few old sessions per request, however many cookies were planted', () => {
    const cookie = Array.from({ length: 12 }, (_, n) => `mx_refresh_${String(n).padStart(20, '0')}=a.b.c`).join('; ');

    expect(legacySessions(carrying(cookie))).toHaveLength(OLD_SESSIONS_PER_REQUEST);
  });

  it('sends no value that is not a token, and still lets its cookie be cleared', () => {
    expect(legacySessions(carrying('mx_refresh=not-a-token'))).toEqual([{ names: ['mx_refresh'] }]);
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
