import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

const access = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

const signedIn = (refresh = 'refresh') =>
  new NextRequest('http://exchange.test/api/auth/logout', {
    method: 'POST',
    headers: { cookie: `mx_access=${access}; mx_refresh=${refresh}` },
  });

const cleared = (response: Response) =>
  response.headers.getSetCookie().filter((cookie) => /^mx_(access|refresh)=;/.test(cookie)).length;

describe('signing out through the frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
