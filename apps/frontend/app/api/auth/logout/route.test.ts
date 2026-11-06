import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

const access = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

const signedIn = () =>
  new NextRequest('http://exchange.test/api/auth/logout', {
    method: 'POST',
    headers: { cookie: `mx_access=${access}; mx_refresh=refresh` },
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

  it('forgets the session once the engine ended it, or when it was already over', async () => {
    for (const status of [204, 401]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));

      const response = await POST(signedIn());

      expect(response.status).toBe(204);
      expect(cleared(response)).toBe(2);
    }
  });
});
