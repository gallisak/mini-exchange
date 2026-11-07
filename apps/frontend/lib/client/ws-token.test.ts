import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { waitForToken } from './ws-token';

type Answer = { token: string } | Error | null;

function run(answers: Answer[], cancelAfter = Infinity) {
  let calls = 0;
  const delays: number[] = [];
  const outcome = waitForToken({
    fetchToken: async () => {
      const answer = answers[Math.min(calls++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    cancelled: () => calls >= cancelAfter,
  });
  return { outcome, delays, calls: () => calls };
}

const failed = (status: number, code?: string) => new ApiError(status, 'failed', code);

describe('WebSocket handshake token', () => {
  it('keeps asking while the token service is down instead of connecting without a token', async () => {
    const { outcome, calls } = run([failed(0), failed(503), failed(502), failed(503), { token: 't' }]);

    expect(await outcome).toEqual({ kind: 'token', token: 't' });
    expect(calls()).toBe(5);
  });

  it('backs off up to five seconds between attempts', async () => {
    const { outcome, delays } = run([...Array(7).fill(failed(503)), { token: 't' }]);

    await outcome;
    expect(delays).toEqual([1000, 2000, 3000, 4000, 5000, 5000, 5000]);
  });

  it('stops at once when the session is gone', async () => {
    const { outcome, calls } = run([failed(401)]);

    expect(await outcome).toEqual({ kind: 'signedOut' });
    expect(calls()).toBe(1);
  });

  it('stops at once when the browser moved to another session, instead of asking in a loop', async () => {
    const { outcome, calls } = run([failed(409, 'SESSION_CHANGED')]);

    expect(await outcome).toEqual({ kind: 'sessionChanged' });
    expect(calls()).toBe(1);
  });

  it('keeps asking after a 409 that is about something else', async () => {
    const { outcome, calls } = run([failed(409), { token: 't' }]);

    expect(await outcome).toEqual({ kind: 'token', token: 't' });
    expect(calls()).toBe(2);
  });

  it('gives up when the connection is torn down', async () => {
    const { outcome } = run([failed(503)], 2);

    expect(await outcome).toEqual({ kind: 'cancelled' });
  });
});
