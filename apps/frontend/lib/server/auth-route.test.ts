import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { signIn } from './auth-route';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieName, newSession, readTokens, sessionsIn, storeTokens } from './session';
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
    expect(response.headers.getSetCookie().some((cookie) => /^mx_refresh_[0-9a-z]+=refresh~/.test(cookie))).toBe(true);
    expect(await response.json()).toMatchObject({ session: expect.any(String) });
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

  it('ignores a genuine name that carries a token it was not given', () => {
    const session = newSession();
    const other = newSession();
    const moved = `${cookieName(ACCESS_COOKIE, session)}=attacker-access`;
    const movedRefresh = sessionCookies('a', 'attacker-refresh', other).split('; ')[1].split('=')[1];

    const request = carrying(`${moved}; ${cookieName(REFRESH_COOKIE, session)}=${movedRefresh}`);

    expect(sessionsIn(request)).toEqual([]);
  });

  it('uses the sign-in the page shows rather than the newest one', () => {
    const { older, newer } = signInTwice();
    const cookie = `${sessionCookies('old-access', 'old-refresh', older)}; ${sessionCookies('new-access', 'new-refresh', newer)}`;

    const tokens = readTokens(
      new NextRequest('http://exchange.test/api/wallet', { headers: { cookie, 'x-session-id': older } }),
    );

    expect(tokens).toEqual({ session: older, accessToken: 'old-access', refreshToken: 'old-refresh' });
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

  const signInOver = (cookie: string) =>
    signIn(
      new NextRequest('http://exchange.test/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ email: 'trader@example.com', password: 'password123' }),
      }),
      '/auth/login',
    );

  const engineEnding = (status: number) => {
    const tokens = { accessToken: 'a.e30.s', refreshToken: 'refresh' };
    const engine = vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/end-session')
        ? new Response(null, { status })
        : new Response(JSON.stringify(tokens), { status: 200 }),
    );
    vi.stubGlobal('fetch', engine);
    return engine;
  };

  const clearedNames = (response: Response) =>
    response.headers
      .getSetCookie()
      .filter((cookie) => /Max-Age=0/.test(cookie))
      .map((cookie) => cookie.split('=')[0])
      .sort();

  it('ends on the engine the session a new sign-in makes the browser forget, and only then forgets it', async () => {
    const engine = engineEnding(204);
    const old = newSession();

    const response = await signInOver(sessionCookies('old-access', 'old-refresh', old));

    const ended = engine.mock.calls.find(([url]) => String(url).endsWith('/auth/end-session'));
    expect(JSON.parse(String(ended?.[1]?.body))).toEqual({ refreshToken: 'old-refresh' });
    expect(clearedNames(response)).toEqual([cookieName(ACCESS_COOKIE, old), cookieName(REFRESH_COOKIE, old)].sort());
  });

  it.each([503, 429])('keeps the cookies of a session the engine answered %i for, so the next sign-in ends it', async (status) => {
    engineEnding(status);

    const response = await signInOver(sessionCookies('old-access', 'old-refresh'));

    expect(response.status).toBe(200);
    expect(clearedNames(response)).toEqual([]);
  });

  it('notes which session it could not end, and drops the note once the next sign-in ended it', async () => {
    engineEnding(503);
    const old = newSession();
    const cookie = sessionCookies('old-access', 'old-refresh', old);

    const noted = (await signInOver(cookie)).headers.getSetCookie().find((line) => line.startsWith('mx_ending='));

    expect(noted).toContain(`mx_ending=${old}~`);
    engineEnding(204);
    const after = await signInOver(`${cookie}; ${noted?.split(';')[0]}`);
    expect(clearedNames(after)).toEqual([cookieName(ACCESS_COOKIE, old), 'mx_ending', cookieName(REFRESH_COOKIE, old)].sort());
  });

  it('keeps the cookies of a session whose end the engine never answered', async () => {
    const tokens = { accessToken: 'a.e30.s', refreshToken: 'refresh' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/auth/end-session')) throw new Error('timed out');
        return new Response(JSON.stringify(tokens), { status: 200 });
      }),
    );

    const response = await signInOver(sessionCookies('old-access', 'old-refresh'));

    expect(clearedNames(response)).toEqual([]);
  });

  it.each([401, 400])('forgets a session the engine answers %i for, since it is over already', async (status) => {
    engineEnding(status);
    const old = newSession();

    const response = await signInOver(sessionCookies('old-access', 'old-refresh', old));

    expect(clearedNames(response)).toEqual([cookieName(ACCESS_COOKIE, old), cookieName(REFRESH_COOKIE, old)].sort());
  });

  it('keeps the cookies on /api without the __Host- prefix, where they are needed on / only', () => {
    const response = NextResponse.json({});

    storeTokens(response, { accessToken: 'a', refreshToken: 'r' }, newSession());

    for (const cookie of response.headers.getSetCookie()) expect(cookie).toMatch(/; Path=\/api(;|$)/i);
  });

  it('ends a session of an old cookie and clears it on both paths when someone signs in', async () => {
    const engine = engineEnding(204);

    const response = await signInOver('mx_access=old.access.token; mx_refresh=old.refresh.token');

    const ended = engine.mock.calls.find(([url]) => String(url).endsWith('/auth/end-session'));
    expect(JSON.parse(String(ended?.[1]?.body))).toEqual({ refreshToken: 'old.refresh.token' });
    const cleared = response.headers.getSetCookie().filter((cookie) => /Max-Age=0/.test(cookie));
    for (const name of ['mx_access', 'mx_refresh']) {
      expect(cleared.filter((cookie) => cookie.startsWith(`${name}=`) && /Path=\/api(;|$)/.test(cookie))).toHaveLength(1);
      expect(cleared.filter((cookie) => cookie.startsWith(`${name}=`) && /Path=\/(;|$)/.test(cookie))).toHaveLength(1);
    }
    expect(response.headers.getSetCookie().filter((cookie) => !/Max-Age=0/.test(cookie))).toHaveLength(2);
  });

  it('ends a forgotten session and an old cookie side by side, and keeps every cookie it clears', async () => {
    const tokens = { accessToken: 'a.e30.s', refreshToken: 'refresh' };
    const waiting: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (!String(url).endsWith('/auth/end-session')) return Promise.resolve(new Response(JSON.stringify(tokens), { status: 200 }));
        return new Promise<Response>((resolve) => {
          waiting.push(() => resolve(new Response(null, { status: 204 })));
          if (waiting.length === 2) waiting.forEach((answer) => answer());
          setTimeout(() => resolve(new Response('{}', { status: 503 })), 1_000);
        });
      }),
    );
    const old = newSession();

    const response = await signInOver(`${sessionCookies('old-access', 'old-refresh', old)}; mx_refresh=old.refresh.token`);

    expect(clearedNames(response)).toEqual(
      [cookieName(ACCESS_COOKIE, old), cookieName(REFRESH_COOKIE, old), 'mx_refresh', 'mx_refresh'].sort(),
    );
  });
});
