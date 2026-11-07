import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { newSession } from '@/lib/server/session';
import { sessionCookies } from '@/lib/server/test-session';
import { POST } from './route';

const access = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

const signedIn = (refresh = 'refresh') =>
  new NextRequest('http://exchange.test/api/auth/logout', {
    method: 'POST',
    headers: { cookie: sessionCookies(access, refresh) },
  });

const cleared = (response: Response) =>
  response.headers.getSetCookie().filter((cookie) => /^mx_(access|refresh)_[0-9a-z]+=;/.test(cookie)).length;

describe('signing out through the frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const carrying = (cookie: string, headers: Record<string, string> = {}) =>
    new NextRequest('http://exchange.test/api/auth/logout', { method: 'POST', headers: { cookie, ...headers } });

  it('does not sign out another sign-in than the one the page shows', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);

    const response = await POST(carrying(sessionCookies(access, 'refresh'), { 'x-session-id': newSession() }));

    expect(response.status).toBe(409);
    expect(cleared(response)).toBe(0);
    expect(engine).not.toHaveBeenCalled();
  });

  it('does not sign out another sign-in when only its refresh cookie is left', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const refreshOnly = sessionCookies(access, 'refresh-of-b').split('; ')[1];

    const response = await POST(carrying(refreshOnly, { 'x-session-id': newSession() }));

    expect(response.status).toBe(409);
    expect(engine).not.toHaveBeenCalled();
  });

  it('signs out a sign-in that has no readable access cookie, with a new access token', async () => {
    const session = newSession();
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        paths.push(new URL(url).pathname);
        return new URL(url).pathname === '/auth/refresh'
          ? Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh' })
          : new Response(null, { status: 204 });
      }),
    );

    const response = await POST(carrying(sessionCookies('not-a-token', 'refresh', session), { 'x-session-id': session }));

    expect(paths).toEqual(['/auth/refresh', '/auth/logout']);
    expect(response.status).toBe(204);
  });

  it('clears the cookies when the engine says the session ended but its note is not written yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'SESSION_ENDED', message: 'ended' }, { status: 503 })),
    );

    const response = await POST(signedIn());

    expect(response.status).toBe(503);
    expect(cleared(response)).toBe(2);
  });

  it('forgets a session whose new access token the engine refused, since it is over', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        paths.push(path);
        if (path === '/auth/refresh') return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh' });
        return new Response(null, { status: path === '/auth/logout' ? 401 : 204 });
      }),
    );

    const response = await POST(signedIn());

    expect(response.status).toBe(204);
    expect(cleared(response)).toBe(2);
    expect(response.headers.getSetCookie().filter((cookie) => !/Max-Age=0/.test(cookie))).toEqual([]);
    expect(paths.at(-1)).toBe('/auth/end-session');
  });

  const signedInTwice = () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const older = newSession();
    vi.setSystemTime(2_000_000);
    const newer = newSession();
    vi.useRealTimers();
    return `${sessionCookies(access, 'older-refresh', older)}; ${sessionCookies(access, 'newer-refresh', newer)}`;
  };

  it('ends an older session too, and forgets every cookie once it did', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        paths.push(new URL(url).pathname);
        return new Response(null, { status: 204 });
      }),
    );

    const response = await POST(carrying(signedInTwice()));

    expect(paths.sort()).toEqual(['/auth/end-session', '/auth/logout']);
    expect(response.status).toBe(204);
    expect(cleared(response)).toBe(4);
  });

  it('does not sign out while an older session could not be ended, or that session would take over', async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        paths.push(new URL(url).pathname);
        return new Response('{}', { status: new URL(url).pathname === '/auth/end-session' ? 503 : 204 });
      }),
    );

    const response = await POST(carrying(signedInTwice()));

    expect(paths).toEqual(['/auth/end-session']);
    expect(response.status).toBe(503);
    expect(cleared(response)).toBe(0);
  });

  it('does not report success or forget the session when the engine could not end it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

    const response = await POST(signedIn());

    expect(response.status).toBe(503);
    expect(cleared(response)).toBe(0);
  });

  it('forgets the session once the engine ended it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const response = await POST(signedIn());

    expect(response.status).toBe(204);
    expect(cleared(response)).toBe(2);
  });

  it('ends the refresh session with a new access token when the engine refused one that looked fresh', async () => {
    const calls: { path: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const authorization = new Headers(init.headers).get('authorization');
        calls.push({ path, authorization });
        if (path === '/auth/refresh') {
          return Response.json({ accessToken: 'new-access', refreshToken: 'new-refresh' });
        }
        return new Response(null, { status: authorization === 'Bearer new-access' ? 204 : 401 });
      }),
    );

    const response = await POST(signedIn('refresh-after-a-new-secret'));

    expect(calls.map((call) => call.path)).toEqual(['/auth/logout', '/auth/refresh', '/auth/logout']);
    expect(calls[2].authorization).toBe('Bearer new-access');
    expect(response.status).toBe(204);
    expect(cleared(response)).toBe(2);
  });

  it('forgets the session when the engine refused its access token and its refresh token is over too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new URL(url).pathname === '/auth/refresh'
          ? Response.json({ message: 'invalid' }, { status: 401 })
          : new Response(null, { status: 401 }),
      ),
    );

    const response = await POST(signedIn('refresh-that-ended'));

    expect(response.status).toBe(204);
    expect(cleared(response)).toBe(2);
  });

  it('keeps the session when the engine refused its access token and could not rotate it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new URL(url).pathname === '/auth/refresh'
          ? new Response('{}', { status: 503 })
          : new Response(null, { status: 401 }),
      ),
    );

    const response = await POST(signedIn('refresh-while-the-engine-is-down'));

    expect(response.status).toBe(503);
    expect(cleared(response)).toBe(0);
  });
});
