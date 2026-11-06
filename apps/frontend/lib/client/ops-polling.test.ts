import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPSTREAM_TIMEOUT_MS } from '@/lib/server/upstream';
import { OPS_TIMEOUT_MS, opsView, startOpsPolling } from './ops-polling';

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

  it('keeps showing a failed refresh after the page loaded once, next to the last data it had', () => {
    const report = { engine: 'up' };

    expect(opsView(null, null)).toEqual({ kind: 'loading' });
    expect(opsView(null, 'Engine answered 503')).toEqual({ kind: 'error', message: 'Engine answered 503' });
    expect(opsView(report, 'Engine answered 503')).toEqual({
      kind: 'report',
      report,
      staleBecause: 'Engine answered 503',
    });
    expect(opsView(report, null)).toEqual({ kind: 'report', report, staleBecause: null });
  });

  it('waits for the status longer than the frontend may take for two rotations and two calls, so new cookies still arrive', () => {
    expect(OPS_TIMEOUT_MS).toBeGreaterThan(4 * UPSTREAM_TIMEOUT_MS);
  });
});
