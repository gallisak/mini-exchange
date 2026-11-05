import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { upstream, withSession } from './upstream';

const token = (secondsLeft: number) =>
  ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + secondsLeft })).toString('base64url'), 's'].join('.');

function request(cookies: Record<string, string>) {
  return new NextRequest('http://exchange.test/api/wallet', {
    headers: { cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ') },
  });
}

function upstreamAnswers(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status, body } = answer(url, init);
      return new Response(JSON.stringify(body), { status });
    }),
  );
}

const cleared = (response: Response) =>
  response.headers.getSetCookie().filter((cookie) => /Max-Age=0/.test(cookie)).length;

describe('calling a service with the session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a session the engine just renewed when a service still answers 401', async () => {
    const fresh = { accessToken: token(900), refreshToken: 'new-refresh' };
    upstreamAnswers((url) =>
      url.endsWith('/auth/refresh') ? { status: 200, body: fresh } : { status: 401, body: {} },
    );
    const incoming = request({ mx_access: token(900), mx_refresh: 'old-refresh' });

    const response = await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(response.status).toBe(502);
    expect(cleared(response)).toBe(0);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('mx_refresh=new-refresh'))).toBe(true);
  });

  it('signs out when the session cannot be renewed', async () => {
    upstreamAnswers((url) =>
      url.endsWith('/auth/refresh') ? { status: 401, body: {} } : { status: 401, body: {} },
    );
    const incoming = request({ mx_access: token(900), mx_refresh: 'revoked-refresh' });

    const response = await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(response.status).toBe(401);
    expect(cleared(response)).toBe(2);
  });

  it('names the rotation attempt when it renews a session', async () => {
    const sent: unknown[] = [];
    upstreamAnswers((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        sent.push(JSON.parse(String(init?.body)));
        return { status: 200, body: { accessToken: token(900), refreshToken: 'renewed' } };
      }
      return { status: 200, body: {} };
    });
    const incoming = request({ mx_access: token(-1), mx_refresh: 'aging-refresh' });

    await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(sent).toEqual([{ refreshToken: 'aging-refresh', attempt: expect.any(String) }]);
  });
});
