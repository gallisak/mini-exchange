import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { newSession } from '@/lib/server/session';
import { endingNote, sessionCookies } from '@/lib/server/test-session';
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

  it('moves to the newest sign-in when the one the page shows is gone', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const session = newSession();

    const response = await GET(asking(sessionCookies(access('next'), 'refresh', session), { 'x-session-id': newSession() }));

    expect(await response.json()).toMatchObject({ user: { id: 'next' }, session });
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
    const cleared = response.headers.getSetCookie();
    expect(cleared.map((cookie) => /Path=([^;]*)/.exec(cookie)?.[1])).toEqual(['/', '/api']);
    for (const cookie of cleared) expect(cookie).toMatch(/^mx_refresh=; Max-Age=0/);
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
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  it('asks the engine to end only a few old sessions per request, however many cookies were planted', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const planted = Array.from({ length: 12 }, (_, n) => `mx_refresh_${String(n).padStart(20, '0')}=a.b.c`).join('; ');

    await GET(asking(planted));

    expect(engine).toHaveBeenCalledTimes(4);
  });

  it('moves a page off a session a sign-in is ending, to that sign-in, and ends the old one', async () => {
    const engine = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', engine);
    const { cookie, older, newer } = twoSignIns();

    const response = await GET(asking(`${cookie}; ${endingNote([older])}`, { 'x-session-id': older }));

    expect(await response.json()).toMatchObject({ user: { id: 'attacker' }, session: newer });
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

    const cleared = response.headers.getSetCookie().map((line) => line.split('=')[0]);
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
