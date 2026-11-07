import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { checkSession } from './session-check';

const alice = { id: 'u1', email: 'alice@example.com', role: 'user' as const };

describe('checking who is signed in', () => {
  it('tries again while the exchange is unavailable and gives the answer once it comes', async () => {
    let calls = 0;
    const outcome = await checkSession(
      async () => {
        calls += 1;
        if (calls < 3) throw new ApiError(503, 'unavailable');
        return alice;
      },
      () => true,
      4,
      async () => undefined,
    );

    expect(outcome).toEqual({ answer: alice });
  });

  it('stops trying as soon as a sign-in made the check pointless, instead of keeping the page loading', async () => {
    let wanted = true;
    let calls = 0;
    const outcome = await checkSession(
      async () => {
        calls += 1;
        throw new ApiError(503, 'unavailable');
      },
      () => wanted,
      4,
      async () => {
        wanted = false;
      },
    );

    expect(outcome).toBeNull();
    expect(calls).toBe(1);
  });

  it('gives up after the retries it was given', async () => {
    let calls = 0;
    const outcome = await checkSession(
      async () => {
        calls += 1;
        throw new ApiError(503, 'unavailable');
      },
      () => true,
      1,
      async () => undefined,
    );

    expect(outcome).toEqual({ failed: true });
    expect(calls).toBe(2);
  });

  it('takes a refusal as final without trying again', async () => {
    let calls = 0;
    const outcome = await checkSession(
      async () => {
        calls += 1;
        throw new ApiError(401, 'Sign in to continue');
      },
      () => true,
      4,
      async () => undefined,
    );

    expect(outcome).toEqual({ failed: true });
    expect(calls).toBe(1);
  });
});
