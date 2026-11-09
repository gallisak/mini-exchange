import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { newSession } from './session';
import { endingNote, sessionCookies } from './test-session';
import { forwardedHeaders, upstream, withSession } from './upstream';

const token = (secondsLeft: number) =>
  ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + secondsLeft })).toString('base64url'), 's'].join('.');

function request(access: string, refresh: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://exchange.test/api/wallet', {
    headers: { cookie: sessionCookies(access, refresh), ...headers },
  });
}

function upstreamAnswers(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status, body } = answer(url, init);
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    }),
  );
}

const cleared = (response: Response) =>
  response.headers.getSetCookie().filter((cookie) => /Max-Age=0/.test(cookie)).length;

const stored = (response: Response, token: string) =>
  response.headers.getSetCookie().some((cookie) => new RegExp(`^mx_refresh_[0-9a-z]+=${token}~`).test(cookie));

describe('calling a service with the session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a request from a page whose sign-in the browser no longer has', async () => {
    const call = vi.fn(async () => ({ status: 202, body: {} }));

    const response = await withSession(request(token(900), 'refresh', { 'x-session-id': newSession() }), call);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SESSION_CHANGED' });
    expect(call).not.toHaveBeenCalled();
  });

  it('lets a request through from a page that shows the sign-in of the cookies', async () => {
    const call = vi.fn(async () => ({ status: 202, body: {} }));
    const session = newSession();
    const incoming = new NextRequest('http://exchange.test/api/wallet', {
      headers: { cookie: sessionCookies(token(900), 'refresh', session), 'x-session-id': session },
    });

    const response = await withSession(incoming, call);

    expect(response.status).toBe(202);
    expect(call).toHaveBeenCalledOnce();
  });

  it('calls with the tokens of the sign-in the page shows, even when a newer one is there', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const older = newSession();
    vi.setSystemTime(2_000_000);
    const newer = newSession();
    vi.useRealTimers();
    const call = vi.fn(async () => ({ status: 202, body: {} }));
    const shown = token(900);
    const incoming = new NextRequest('http://exchange.test/api/wallet', {
      headers: {
        cookie: `${sessionCookies(shown, 'older-refresh', older)}; ${sessionCookies(token(800), 'newer-refresh', newer)}`,
        'x-session-id': older,
      },
    });

    await withSession(incoming, call);

    expect(call).toHaveBeenCalledWith(shown);
  });

  it('forgets a session the engine renewed but a service still refuses, and ends what it was just given', async () => {
    const fresh = { accessToken: token(900), refreshToken: 'new-refresh' };
    const ended: unknown[] = [];
    upstreamAnswers((url, init) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: fresh };
      if (url.endsWith('/auth/end-session')) {
        ended.push(JSON.parse(String(init?.body)));
        return { status: 204, body: null };
      }
      return { status: 401, body: {} };
    });
    const incoming = request(token(900), 'old-refresh');

    const response = await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(response.status).toBe(401);
    expect(cleared(response)).toBe(2);
    expect(stored(response, 'new-refresh')).toBe(false);
    expect(ended).toEqual([{ refreshToken: 'new-refresh' }]);
  });

  it('keeps the new pair and answers 503 when the engine cannot end a session a service refused, so the next request ends it', async () => {
    const fresh = { accessToken: token(900), refreshToken: 'new-refresh' };
    upstreamAnswers((url) => {
      if (url.endsWith('/auth/refresh')) return { status: 200, body: fresh };
      if (url.endsWith('/auth/end-session')) return { status: 503, body: {} };
      return { status: 401, body: {} };
    });
    const incoming = request(token(900), 'refused-refresh');

    const response = await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(response.status).toBe(503);
    expect(cleared(response)).toBe(0);
    expect(stored(response, 'new-refresh')).toBe(true);
  });

  describe('with a session a sign-in could not end', () => {
    const old = newSession();
    const current = newSession();
    const asking = (note: string, shows = current) =>
      new NextRequest('http://exchange.test/api/wallet', {
        headers: {
          cookie: `${sessionCookies(token(900), 'old-refresh', old)}; ${sessionCookies(token(900), 'refresh', current)}; ${note}`,
          'x-session-id': shows,
        },
      });
    const engineEnding = (status: number) => {
      const engine = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status }));
      vi.stubGlobal('fetch', engine);
      return engine;
    };
    const call = async () => ({ status: 200, body: {} });
    const clearedNames = (response: Response) =>
      response.headers
        .getSetCookie()
        .filter((cookie) => /Max-Age=0/.test(cookie))
        .map((cookie) => cookie.split('=')[0]);

    it('tries again on the next request, and forgets it once the engine ended it', async () => {
      const engine = engineEnding(204);

      const response = await withSession(asking(endingNote([old])), call);

      expect(response.status).toBe(200);
      expect(String(engine.mock.calls[0][0])).toMatch(/\/auth\/end-session$/);
      expect(JSON.parse(String(engine.mock.calls[0][1]?.body))).toEqual({ refreshToken: 'old-refresh' });
      expect(clearedNames(response).sort()).toEqual([`mx_access_${old}`, `mx_refresh_${old}`].sort());
    });

    it('leaves the note alone, so a request that crossed a sign-in cannot drop what that sign-in noted', async () => {
      engineEnding(204);

      const response = await withSession(asking(endingNote([old])), call);

      expect(response.headers.getSetCookie().filter((cookie) => cookie.startsWith('mx_ending'))).toEqual([]);
    });

    it('ends the session alongside the call instead of after it', async () => {
      const engine = engineEnding(204);
      let finish!: () => void;
      const slow = vi.fn(
        () => new Promise<{ status: number; body: unknown }>((resolve) => (finish = () => resolve({ status: 200, body: {} }))),
      );

      const answered = withSession(asking(endingNote([old])), slow);
      await vi.waitFor(() => expect(engine).toHaveBeenCalledOnce());
      finish();
      const response = await answered;

      expect(slow).toHaveBeenCalledOnce();
      expect(clearedNames(response).sort()).toEqual([`mx_access_${old}`, `mx_refresh_${old}`].sort());
    });

    it('keeps its cookies and the note while the engine cannot end it', async () => {
      engineEnding(503);

      const response = await withSession(asking(endingNote([old])), call);

      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('ends nothing on a note the frontend did not sign, so a planted one cannot end a real session', async () => {
      const engine = engineEnding(204);

      const response = await withSession(asking(`mx_ending=${old}~${'0'.repeat(32)}`), call);

      expect(engine).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('refuses a request for a session a sign-in is ending, so the page moves to that sign-in', async () => {
      engineEnding(204);
      const slow = vi.fn(call);

      const response = await withSession(asking(endingNote([old]), old), slow);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'SESSION_CHANGED' });
      expect(slow).not.toHaveBeenCalled();
    });

    it('takes a session that is being ended for no sign-in at all once nothing else is left', async () => {
      engineEnding(503);
      const slow = vi.fn(call);
      const incoming = new NextRequest('http://exchange.test/api/wallet', {
        headers: { cookie: `${sessionCookies(token(900), 'old-refresh', old)}; ${endingNote([old])}`, 'x-session-id': old },
      });

      const response = await withSession(incoming, slow);

      expect(response.status).toBe(401);
      expect(slow).not.toHaveBeenCalled();
    });
  });

  it('vouches for the address of the browser to the engine with a key made for that, and tells settlement nothing', () => {
    vi.stubEnv('FRONTEND_PROXY_KEY', 'proxy-key');
    const incoming = request(token(900), 'refresh', { 'x-forwarded-for': '203.0.113.7' });

    const engine = forwardedHeaders(incoming, 'engine');
    const settlement = forwardedHeaders(incoming, 'settlement');
    vi.unstubAllEnvs();

    expect(engine['x-client-ip']).toBe('203.0.113.7');
    expect(engine['x-proxy-key']).toBe('45b3e07d034673b9e8bfa1e6e415e26a669844bdce1b7493ebe33c82d094cc76');
    expect(settlement).toEqual({ 'x-request-id': expect.any(String) });
  });

  it('answers 503 when the body of an answer breaks off, instead of failing the request', async () => {
    const broken = new Response(
      new ReadableStream({
        start: (controller) => controller.error(new Error('aborted')),
      }),
      { status: 200 },
    );
    vi.stubGlobal('fetch', vi.fn(async () => broken));

    const result = await upstream(request(token(900), 'refresh'), 'engine', '/orders');

    expect(result.status).toBe(503);
  });

  it('signs out the session the request was sent with when it cannot be renewed', async () => {
    upstreamAnswers((url) =>
      url.endsWith('/auth/refresh') ? { status: 401, body: {} } : { status: 401, body: {} },
    );
    const incoming = request(token(900), 'revoked-refresh');

    const response = await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(response.status).toBe(401);
    expect(cleared(response)).toBe(2);
  });

  it('keeps the cookies when a late request brings a refresh token that a newer rotation already replaced', async () => {
    upstreamAnswers((url) =>
      url.endsWith('/auth/refresh') ? { status: 409, body: {} } : { status: 401, body: {} },
    );
    const incoming = request(token(900), 'replaced-refresh');

    const response = await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(response.status).toBe(503);
    expect(cleared(response)).toBe(0);
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
    const incoming = request(token(-1), 'aging-refresh');

    await withSession(incoming, (accessToken) =>
      upstream(incoming, 'settlement', '/wallets/me', {}, accessToken),
    );

    expect(sent).toEqual([{ refreshToken: 'aging-refresh', attempt: expect.any(String) }]);
  });

  it('shares a rotation with the same browser after it moved to another network', async () => {
    const session = newSession();
    const from = (address: string) =>
      new NextRequest('http://exchange.test/api/wallet', {
        headers: {
          cookie: sessionCookies(token(-1), 'roaming-refresh', session),
          'x-forwarded-for': address,
          'user-agent': 'Phone Browser',
        },
      });
    const call = (incoming: NextRequest) =>
      withSession(incoming, (accessToken) => upstream(incoming, 'settlement', '/wallets/me', {}, accessToken));
    const sent: unknown[] = [];
    upstreamAnswers((url, init) => {
      if (url.endsWith('/auth/refresh')) {
        sent.push(JSON.parse(String(init?.body)).attempt);
        return { status: 503, body: {} };
      }
      return { status: 200, body: {} };
    });

    await call(from('198.51.100.1'));
    await call(from('203.0.113.9'));

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });
});
