import { describe, expect, it } from 'vitest';
import { waitForToken } from './ws-token';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function run(responses: (Response | null)[], cancelAfter = Infinity) {
  let calls = 0;
  const delays: number[] = [];
  const outcome = waitForToken({
    fetchToken: async () => responses[Math.min(calls++, responses.length - 1)],
    sleep: async (ms) => {
      delays.push(ms);
    },
    cancelled: () => calls >= cancelAfter,
  });
  return { outcome, delays, calls: () => calls };
}

describe('WebSocket handshake token', () => {
  it('keeps asking while the token service is down instead of connecting without a token', async () => {
    const { outcome, calls } = run([null, json(503, {}), json(502, {}), json(503, {}), json(200, { token: 't' })]);

    expect(await outcome).toEqual({ kind: 'token', token: 't' });
    expect(calls()).toBe(5);
  });

  it('backs off up to five seconds between attempts', async () => {
    const { outcome, delays } = run([...Array(7).fill(json(503, {})), json(200, { token: 't' })]);

    await outcome;
    expect(delays).toEqual([1000, 2000, 3000, 4000, 5000, 5000, 5000]);
  });

  it('stops at once when the session is gone', async () => {
    const { outcome, calls } = run([json(401, {})]);

    expect(await outcome).toEqual({ kind: 'signedOut' });
    expect(calls()).toBe(1);
  });

  it('gives up when the connection is torn down', async () => {
    const { outcome } = run([json(503, {})], 2);

    expect(await outcome).toEqual({ kind: 'cancelled' });
  });
});
