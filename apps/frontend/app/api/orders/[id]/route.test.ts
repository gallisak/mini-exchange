import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { sessionCookies } from '@/lib/server/test-session';
import { DELETE } from './route';

const access = ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url'), 's'].join('.');

describe('cancelling an order through the frontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends nothing to the engine for an id that is not an order id', async () => {
    const engine = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', engine);

    for (const id of ['..', '.', '../health', 'not-an-id']) {
      const response = await DELETE(
        new NextRequest(`http://exchange.test/api/orders/x`, {
          method: 'DELETE',
          headers: { cookie: sessionCookies(access, 'refresh') },
        }),
        { params: { id } },
      );
      expect(response.status, id).toBe(400);
    }
    expect(engine).not.toHaveBeenCalled();
  });
});
