import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_REUSE_WINDOW_MS, Rotation, refreshOnce } from './session';

describe('sharing one refresh between requests', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rotated = (n: number): Rotation => ({
    kind: 'rotated',
    tokens: { accessToken: `access-${n}`, refreshToken: `refresh-${n}` },
  });

  it('gives requests that raced the rotation the same new pair', async () => {
    const rotate = vi.fn(async () => rotated(1));

    const [first, second] = await Promise.all([
      refreshOnce('shared-a', rotate),
      refreshOnce('shared-a', rotate),
    ]);
    const late = await refreshOnce('shared-a', rotate);

    expect(rotate).toHaveBeenCalledTimes(1);
    expect([first, second, late]).toEqual([rotated(1), rotated(1), rotated(1)]);
  });

  it('stops handing out the new pair for the old token after a few seconds', async () => {
    let n = 0;
    const rotate = vi.fn(async () => rotated(++n));
    await refreshOnce('shared-b', rotate);

    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_WINDOW_MS);
    await refreshOnce('shared-b', rotate);

    expect(REFRESH_REUSE_WINDOW_MS).toBeLessThanOrEqual(5_000);
    expect(rotate).toHaveBeenCalledTimes(2);
  });
});
