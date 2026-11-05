import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signIn } from './auth-route';

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
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('mx_refresh=refresh'))).toBe(true);
  });
});
