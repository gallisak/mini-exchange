import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { newSession } from '@/lib/server/session';
import { endingNote, sessionCookies } from '@/lib/server/test-session';
import { withSession } from '@/lib/server/upstream';
import { GET } from './route';

const access = (sub: string) =>
  ['e30', Buffer.from(JSON.stringify({ sub, email: `${sub}@example.com`, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

const asking = (cookie: string, headers: Record<string, string> = {}) =>
  new NextRequest('http://exchange.test/api/auth/session', { headers: { cookie, ...headers } });

const twoSignIns = () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const older = newSession();
  vi.setSystemTime(2_000_000);
  const newer = newSession();
  vi.useRealTimers();
  return {
    older,
    newer,
    cookie: `${sessionCookies(access('victim'), 'victim-refresh', older)}; ${sessionCookies(access('attacker'), 'attacker-refresh', newer)}`,
  };
};

describe('asking who is signed in', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers with the newest sign-in on a first load, and neither ends nor forgets another one', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const { cookie, newer } = twoSignIns();

    const response = await GET(asking(cookie));

    expect(await response.json()).toMatchObject({ user: { id: 'attacker' }, session: newer });
    expect(engine).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('ends only a session a sign-in of this browser could not end, and forgets it', async () => {
    const engine = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const { cookie, older, newer } = twoSignIns();

    const response = await GET(asking(`${cookie}; ${endingNote([older])}`, { 'x-session-id': newer }));

    expect(JSON.parse(String(engine.mock.calls[0][1]?.body))).toEqual({ refreshToken: 'victim-refresh' });
    expect(engine).toHaveBeenCalledOnce();
    const cleared = response.headers.getSetCookie().map((line) => line.split('=')[0]);
    expect(cleared.sort()).toEqual([`mx_access_${older}`, `mx_refresh_${older}`].sort());
  });

  it('stays with the sign-in the page shows when a newer one appears', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { cookie, older } = twoSignIns();

    const response = await GET(asking(cookie, { 'x-session-id': older }));

    expect(await response.json()).toMatchObject({ user: { id: 'victim' }, session: older });
  });

  it('tells a page whose own sign-in is gone that it is signed out, instead of giving it another one', async () => {
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);
    const session = newSession();

    const response = await GET(asking(sessionCookies(access('planted'), 'refresh', session), { 'x-session-id': newSession() }));

    expect(await response.json()).toEqual({ user: null, session: null });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(engine).not.toHaveBeenCalled();
  });

  it('asks the engine about a session another request just rotated, instead of trusting its fresh access cookie', async () => {
    let sessionCheck = 200;
    const paths: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        paths.push(path);
        if (path === '/auth/session') return new Response('{}', { status: sessionCheck });
        if (path !== '/auth/refresh') return new Response(null, { status: 204 });
        return JSON.parse(String(init?.body)).refreshToken === 'refresh'
          ? Response.json({ accessToken: access('u'), refreshToken: 'rotated-refresh' })
          : Response.json({ message: 'over' }, { status: 401 });
      }),
    );
    const session = newSession();
    const stale = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: 1 })).toString('base64url'), 's'].join('.');
    const rotating = await withSession(
      new NextRequest('http://exchange.test/api/wallet', {
        headers: { cookie: sessionCookies(stale, 'refresh', session), 'x-session-id': session },
      }),
      async () => ({ status: 200, body: {} }),
    );
    const rotated = rotating.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');

    const alive = await GET(asking(rotated, { 'x-session-id': session }));
    expect(await alive.json()).toMatchObject({ user: { id: 'u' }, session });
    expect(paths.at(-1)).toBe('/auth/session');

    sessionCheck = 401;
    const over = await GET(asking(rotated, { 'x-session-id': session }));
    expect(await over.json()).toEqual({ user: null, session: null });
    expect(paths.slice(-2)).toEqual(['/auth/session', '/auth/refresh']);
    expect(over.headers.getSetCookie().filter((cookie) => /Max-Age=0/.test(cookie))).toHaveLength(2);
  });

  it('answers nobody without a session, and asks the engine nothing', async () => {
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);

    const response = await GET(asking(''));

    expect(await response.json()).toEqual({ user: null, session: null });
    expect(engine).not.toHaveBeenCalled();
  });

  it('ends an old cookie on /api and clears it there and on /', async () => {
    const ended: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        ended.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );

    const response = await GET(asking('mx_refresh=old.refresh.token'));

    expect(ended).toEqual([{ refreshToken: 'old.refresh.token' }]);
    const cleared = response.headers.getSetCookie().filter((cookie) => cookie.startsWith('mx_refresh='));
    expect(cleared.map((cookie) => /Path=([^;]*)/.exec(cookie)?.[1])).toEqual(['/', '/api']);
    for (const cookie of cleared) expect(cookie).toMatch(/^mx_refresh=; Max-Age=0/);
  });

  it('does not end an old cookie again once it did, when the cookie could not be cleared', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const first = await GET(asking('mx_refresh=old.refresh.token'));
    const done = first.headers.getSetCookie().find((cookie) => cookie.startsWith('mx_legacy_done='))?.split(';')[0];

    const again = await GET(asking(`mx_refresh=old.refresh.token; ${done}`));

    expect(engine).toHaveBeenCalledOnce();
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it('ends the session of an old cookie with its access token when its refresh cookie is gone', async () => {
    const calls: { path: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ path: new URL(url).pathname, authorization: new Headers(init.headers).get('authorization') });
        return new Response(null, { status: 204 });
      }),
    );

    const response = await GET(asking('mx_access=old.access.token'));

    expect(calls).toEqual([{ path: '/auth/logout', authorization: 'Bearer old.access.token' }]);
    expect(response.headers.getSetCookie().filter((cookie) => /^mx_access=; Max-Age=0/.test(cookie))).toHaveLength(2);
  });

  it('keeps an old cookie the engine could not end, to try again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

    const response = await GET(asking('mx_refresh=old.refresh.token'));

    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('clears an old cookie that holds no token without asking the engine', async () => {
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);

    const response = await GET(asking('mx_refresh=planted'));

    expect(engine).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().filter((cookie) => /^mx_refresh=; Max-Age=0/.test(cookie))).toHaveLength(2);
  });

  it('asks the engine to end only a few old sessions per request, however many cookies were planted', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const planted = Array.from({ length: 12 }, (_, n) => `mx_refresh_${String(n).padStart(20, '0')}=a.b.c`).join('; ');

    await GET(asking(planted));

    expect(engine).toHaveBeenCalledTimes(4);
  });

  it('tells a page on a session a sign-in is ending that it is signed out, rather than moving it, and ends the old one', async () => {
    const engine = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const { cookie, older } = twoSignIns();

    const response = await GET(asking(`${cookie}; ${endingNote([older])}`, { 'x-session-id': older }));

    expect(await response.json()).toEqual({ user: null, session: null });
    expect(JSON.parse(String(engine.mock.calls[0][1]?.body))).toEqual({ refreshToken: 'victim-refresh' });
  });

  it('ends a listed session and an old cookie side by side, and keeps every cookie it clears', async () => {
    const waiting: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            waiting.push(() => resolve(new Response(null, { status: 204 })));
            if (waiting.length === 2) waiting.forEach((answer) => answer());
            setTimeout(() => resolve(new Response('{}', { status: 503 })), 1_000);
          }),
      ),
    );
    const { cookie, older, newer } = twoSignIns();

    const response = await GET(asking(`${cookie}; ${endingNote([older])}; mx_refresh=old.refresh.token`, { 'x-session-id': newer }));

    const cleared = response.headers
      .getSetCookie()
      .filter((line) => /Max-Age=0/.test(line))
      .map((line) => line.split('=')[0]);
    expect(cleared.sort()).toEqual([`mx_access_${older}`, `mx_refresh_${older}`, 'mx_refresh', 'mx_refresh'].sort());
  });

  it('clears old cookies alongside a rotation of the current session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        new URL(url).pathname === '/auth/refresh'
          ? Response.json({ accessToken: access('u'), refreshToken: 'new-refresh' })
          : new Response(null, { status: 204 }),
      ),
    );

    const response = await GET(asking(`${sessionCookies('stale', 'refresh')}; mx_refresh=old-refresh`));

    const cookies = response.headers.getSetCookie();
    expect(cookies.filter((cookie) => /=new-refresh~/.test(cookie))).toHaveLength(1);
    expect(cookies.filter((cookie) => /^mx_refresh=;/.test(cookie))).toHaveLength(2);
  });
});
