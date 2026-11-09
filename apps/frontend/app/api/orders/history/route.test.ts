import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sessionCookies } from '@/lib/server/test-session';
import { GET } from './route';

const access = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

const asking = (query: string) =>
  new NextRequest(`http://exchange.test/api/orders/history?${query}`, { headers: { cookie: sessionCookies(access, 'refresh') } });

describe('paging through finished orders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the engine for the orders before the oldest one shown', async () => {
    const engine = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', engine);

    const response = await GET(asking('before=2026-11-09T10:00:00.000Z&beforeId=6f0c7a52-3a8e-4c55-9d64-2f6f2d1f9b10'));

    expect(response.status).toBe(200);
    expect(String((engine.mock.calls[0] as unknown[])[0])).toMatch(
      /\/orders\/history\?before=2026-11-09T10%3A00%3A00.000Z&beforeId=6f0c7a52-3a8e-4c55-9d64-2f6f2d1f9b10$/,
    );
  });

  it('refuses a page that does not name the oldest order shown, without asking the engine', async () => {
    const engine = vi.fn();
    vi.stubGlobal('fetch', engine);

    const response = await GET(asking('before=yesterday&beforeId=nope'));

    expect(response.status).toBe(400);
    expect(engine).not.toHaveBeenCalled();
  });
});
