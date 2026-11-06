import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sessionCookies } from '@/lib/server/test-session';
import { GET } from './route';

const access = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

describe('reconciliation through the frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('waits as long as a reconciliation may take instead of the usual ten seconds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })));
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await GET(new NextRequest('http://exchange.test/api/ops/reconciliation', { headers: { cookie: sessionCookies(access) } }));

    expect(Math.max(...timeout.mock.calls.map(([ms]) => ms))).toBeGreaterThanOrEqual(60_000);
  });
});
