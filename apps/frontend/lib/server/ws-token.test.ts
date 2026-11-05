import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { issueWsToken } from './ws-token';

const token = (secondsLeft: number) =>
  ['e30', Buffer.from(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + secondsLeft })).toString('base64url'), 's'].join('.');

function engineAnswers(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('a token for the real-time connection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const incoming = (access: string) =>
    new NextRequest('http://exchange.test/api/ws-token', {
      headers: { cookie: `mx_access=${access}; mx_refresh=refresh` },
    });

  it('is the short ticket the engine issues', async () => {
    engineAnswers(200, { ticket: 'ticket-1' });

    const response = await issueWsToken(incoming(token(900)));

    expect(await response.json()).toEqual({ token: 'ticket-1' });
  });

  it('is still the access token while the engine does not issue tickets yet', async () => {
    const access = token(900);
    engineAnswers(404, { message: 'Cannot POST /auth/ws-ticket' });

    const response = await issueWsToken(incoming(access));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: access });
  });
});
