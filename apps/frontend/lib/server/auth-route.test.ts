import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signIn } from './auth-route';
import { readTokens } from './session';
import { withSession } from './upstream';

describe('signing in through the frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
    const oldCookies = 'mx_access_0000000001old=expired; mx_refresh_0000000001old=revoked';
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
    expect(named(lateAnswer, true).sort()).toEqual(['mx_access_0000000001old', 'mx_refresh_0000000001old']);
    expect(named(lateAnswer, true).some((name) => kept.includes(name))).toBe(false);
    expect(named(login, true).sort()).toEqual(['mx_access_0000000001old', 'mx_refresh_0000000001old']);
  });

  it('uses the newest sign-in when cookies of an older one are still there', () => {
    const request = new NextRequest('http://exchange.test/api/wallet', {
      headers: {
        cookie: 'mx_access=legacy; mx_refresh=legacy; mx_access_00000000zzaaa=new-access; mx_refresh_00000000zzaaa=new-refresh; mx_refresh_000000001bbb=older',
      },
    });

    expect(readTokens(request)).toEqual({ session: '00000000zzaaa', accessToken: 'new-access', refreshToken: 'new-refresh' });
  });
});
