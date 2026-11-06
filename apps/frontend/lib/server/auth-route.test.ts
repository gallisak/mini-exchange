import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { signIn } from './auth-route';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieName, newSession, readTokens, storeTokens } from './session';
import { sessionCookies } from './test-session';
import { withSession } from './upstream';

describe('signing in through the frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('refuses a sign-in that a form on another site could send', async () => {
    const engine = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', engine);
    const forged = new NextRequest('http://exchange.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ email: 'attacker@example.com', password: 'password123' }),
    });

    const response = await signIn(forged, '/auth/login');

    expect(response.status).toBe(415);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(engine).not.toHaveBeenCalled();
  });

  it('signs in with a JSON body', async () => {
    const tokens = { accessToken: 'a.e30.s', refreshToken: 'refresh' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(tokens), { status: 200 })));
    const request = new NextRequest('http://exchange.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ email: 'trader@example.com', password: 'password123' }),
    });

    const response = await signIn(request, '/auth/login');

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().some((cookie) => /^mx_refresh_[0-9a-z]+=refresh;/.test(cookie))).toBe(true);
  });

  it('keeps a new sign-in out of reach of a late answer that clears the session it replaced', async () => {
    const tokens = { accessToken: 'a.e30.s', refreshToken: 'refresh' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/auth/refresh')
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify(tokens), { status: 200 }),
    ));
    const old = newSession();
    const oldNames = [cookieName(ACCESS_COOKIE, old), cookieName(REFRESH_COOKIE, old)].sort();
    const oldCookies = sessionCookies('expired', 'revoked', old);
    const late = withSession(
      new NextRequest('http://exchange.test/api/wallet', { headers: { cookie: oldCookies } }),
      async () => ({ status: 200, body: {} }),
    );
    const login = await signIn(
      new NextRequest('http://exchange.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: oldCookies },
        body: JSON.stringify({ email: 'trader@example.com', password: 'password123' }),
      }),
      '/auth/login',
    );
    const lateAnswer = await late;

    const named = (response: Response, cleared: boolean) =>
      response.headers
        .getSetCookie()
        .filter((cookie) => /Max-Age=0/.test(cookie) === cleared)
        .map((cookie) => cookie.split('=')[0]);
    const kept = named(login, false);
    expect(kept).toHaveLength(2);
    expect(lateAnswer.status).toBe(401);
    expect(named(lateAnswer, true).sort()).toEqual(oldNames);
    expect(named(lateAnswer, true).some((name) => kept.includes(name))).toBe(false);
    expect(named(login, true).sort()).toEqual(oldNames);
  });

  const signInTwice = () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const older = newSession();
    vi.setSystemTime(2_000_000);
    return { older, newer: newSession() };
  };

  const carrying = (cookie: string) => new NextRequest('http://exchange.test/api/wallet', { headers: { cookie } });

  it('uses the newest sign-in when cookies of an older one are still there', () => {
    const { older, newer } = signInTwice();

    expect(
      readTokens(carrying(`${sessionCookies('old', 'older', older)}; ${sessionCookies('new-access', 'new-refresh', newer)}`)),
    ).toEqual({ session: newer, accessToken: 'new-access', refreshToken: 'new-refresh' });
  });

  it('does not let a planted cookie win with a name that sorts last or has no session', () => {
    const session = newSession();
    const planted = 'z'.repeat(20) + '0'.repeat(16);
    const cookie = [
      sessionCookies('victim-access', 'victim-refresh', session),
      `mx_access_${planted}=attacker-access`,
      `mx_refresh_${planted}=attacker-refresh`,
      'mx_access=attacker-access',
      'mx_refresh=attacker-refresh',
    ].join('; ');

    expect(readTokens(carrying(cookie))).toEqual({
      session,
      accessToken: 'victim-access',
      refreshToken: 'victim-refresh',
    });
  });

  it('reads no session from planted cookies alone', () => {
    expect(readTokens(carrying(`mx_access_${'z'.repeat(36)}=attacker; mx_refresh=attacker`))).toEqual({ session: '' });
  });

  it('names the cookies so that a browser takes them only from this host over HTTPS', () => {
    vi.stubEnv('COOKIE_SECURE', 'true');
    const response = NextResponse.json({});
    const session = newSession();

    storeTokens(response, { accessToken: 'a', refreshToken: 'r' }, session);

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-mx_(access|refresh)_/);
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/; Path=\/(;|$)/i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
  });

  it('ignores a genuine session under a name without the prefix once cookies are secure', () => {
    const plain = sessionCookies('attacker-access', 'attacker-refresh');
    vi.stubEnv('COOKIE_SECURE', 'true');
    const session = newSession();

    expect(readTokens(carrying(`${sessionCookies('own-access', 'own-refresh', session)}; ${plain}`))).toEqual({
      session,
      accessToken: 'own-access',
      refreshToken: 'own-refresh',
    });
  });

  it('ends on the engine the session a new sign-in makes the browser forget', async () => {
    const tokens = { accessToken: 'a.e30.s', refreshToken: 'refresh' };
    const engine = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(tokens), { status: 200 }));
    vi.stubGlobal('fetch', engine);

    await signIn(
      new NextRequest('http://exchange.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: sessionCookies('old-access', 'old-refresh') },
        body: JSON.stringify({ email: 'trader@example.com', password: 'password123' }),
      }),
      '/auth/login',
    );

    await vi.waitFor(() => {
      const ended = engine.mock.calls.find(([url]) => String(url).endsWith('/auth/end-session'));
      expect(JSON.parse(String(ended?.[1]?.body))).toEqual({ refreshToken: 'old-refresh' });
    });
  });
});
