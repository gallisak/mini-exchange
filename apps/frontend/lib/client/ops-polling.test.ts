import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startOpsPolling } from './ops-polling';

describe('operations page polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes the status every 5 s but reconciles only once a minute', () => {
    const status = vi.fn();
    const reconcile = vi.fn();

    const stop = startOpsPolling(status, reconcile);
    vi.advanceTimersByTime(120_000);

    expect(status).toHaveBeenCalledTimes(1 + 24);
    expect(reconcile).toHaveBeenCalledTimes(1 + 2);
    stop();
  });

  it('stops both once the page is left', () => {
    const status = vi.fn();
    const reconcile = vi.fn();

    startOpsPolling(status, reconcile)();
    vi.advanceTimersByTime(120_000);

    expect(status).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
