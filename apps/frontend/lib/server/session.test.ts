import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { REFRESH_REUSE_WINDOW_MS, Rotation, refreshOnce, storeTokens } from './session';

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
      refreshOnce({ refreshToken: 'shared-a', accessToken: 'access-a' }, rotate),
      refreshOnce({ refreshToken: 'shared-a', accessToken: 'access-a' }, rotate),
    ]);
    const late = await refreshOnce({ refreshToken: 'shared-a', accessToken: 'access-a' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(1);
    expect([first, second, late]).toEqual([rotated(1), rotated(1), rotated(1)]);
  });

  it('stops handing out the new pair for the old token after a few seconds', async () => {
    let n = 0;
    const rotate = vi.fn(async () => rotated(++n));
    await refreshOnce({ refreshToken: 'shared-b', accessToken: 'access-b' }, rotate);

    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_WINDOW_MS);
    await refreshOnce({ refreshToken: 'shared-b', accessToken: 'access-b' }, rotate);

    expect(REFRESH_REUSE_WINDOW_MS).toBeLessThanOrEqual(5_000);
    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('does not hand the new pair to someone who has the old refresh token without its access token', async () => {
    const rotate = vi.fn(async () => rotated(1));
    await refreshOnce({ refreshToken: 'stolen', accessToken: 'access-c' }, rotate);
    await refreshOnce({ refreshToken: 'stolen', accessToken: 'access-c' }, rotate);

    await refreshOnce({ refreshToken: 'stolen' }, rotate);
    await refreshOnce({ refreshToken: 'stolen', accessToken: 'forged' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(3);
  });

  it('does not share a rotation with another client, even when it brings the same cookies', async () => {
    const rotate = vi.fn(async () => rotated(1));

    await refreshOnce({ refreshToken: 'copied', accessToken: 'access-e', client: '203.0.113.5 Firefox' }, rotate);
    await refreshOnce({ refreshToken: 'copied', accessToken: 'access-e', client: '198.51.100.7 curl' }, rotate);

    expect(rotate).toHaveBeenCalledTimes(2);
  });

  it('keeps the attempt of a rotation for a later request that still brings the old cookies', async () => {
    const rotate = vi.fn(async (_token: string, _attempt: string) => rotated(1));
    await refreshOnce({ refreshToken: 'kept', accessToken: 'access-f' }, rotate);

    await vi.advanceTimersByTimeAsync(REFRESH_REUSE_WINDOW_MS + 1_000);
    await refreshOnce({ refreshToken: 'kept', accessToken: 'access-f' }, rotate);

    const [first, second] = rotate.mock.calls.map(([, attempt]) => attempt);
    expect(second).toBe(first);
  });

  it('keeps the attempt of a lost rotation for minutes, not just one', async () => {
    const outcomes: Rotation[] = [{ kind: 'unavailable' }, rotated(1)];
    const rotate = vi.fn(async (_token: string, _attempt: string) => outcomes.shift() as Rotation);
    await refreshOnce({ refreshToken: 'slow', accessToken: 'access-g' }, rotate);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await refreshOnce({ refreshToken: 'slow', accessToken: 'access-g' }, rotate);

    const [first, second] = rotate.mock.calls.map(([, attempt]) => attempt);
    expect(second).toBe(first);
  });

  it('retries a rotation whose answer was lost as the same attempt', async () => {
    const outcomes: Rotation[] = [{ kind: 'unavailable' }, rotated(1)];
    const rotate = vi.fn(async (_token: string, _attempt: string) => outcomes.shift() as Rotation);

    await refreshOnce({ refreshToken: 'lost', accessToken: 'access-d' }, rotate);
    await refreshOnce({ refreshToken: 'lost', accessToken: 'access-d' }, rotate);

    const [first, second] = rotate.mock.calls.map(([, attempt]) => attempt);
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });

  it('keeps the access cookie as long as the refresh cookie, so a refresh can be tied to both', () => {
    const response = NextResponse.json({});

    storeTokens(response, { accessToken: 'a', refreshToken: 'r' });

    const ages = response.headers
      .getSetCookie()
      .map((cookie) => [cookie.split('=')[0], /Max-Age=(\d+)/.exec(cookie)?.[1]]);
    expect(Object.fromEntries(ages)).toEqual({ mx_access: '604800', mx_refresh: '604800' });
  });
});
