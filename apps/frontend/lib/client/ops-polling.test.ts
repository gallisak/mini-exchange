import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  OPS_TIMEOUT_MS,
  OPS_UPSTREAM_TIMEOUT_MS,
  RECONCILE_TIMEOUT_MS,
  RECONCILIATION_UPSTREAM_TIMEOUT_MS,
  longestAnswer,
} from '@/lib/timeouts';
import { opsView, startOpsPolling, reconciliationBadge } from './ops-polling';

describe('the reconciliation badge', () => {
  it('does not stay a clean ok next to a refresh that failed', () => {
    expect(reconciliationBadge('ok', false)).toEqual({ label: 'ok', variant: 'secondary', state: 'passed' });
    expect(reconciliationBadge('ok', true)).toEqual({ label: 'ok · stale', variant: 'outline', state: 'stale' });
  });

  it('keeps a mismatch red, stale or not', () => {
    expect(reconciliationBadge('mismatch', true)).toEqual({
      label: 'mismatch · stale',
      variant: 'destructive',
      state: 'failed',
    });
  });
});

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

  it('waits longer than the frontend may take for two rotations and two calls, and nginx lets it, so new cookies still arrive', () => {
    const web = readFileSync(resolve(__dirname, '../../../../docker/nginx/web.conf'), 'utf8');
    const readTimeout = (location: string) =>
      Number(new RegExp(`location ${location} \\{[^}]*proxy_read_timeout (\\d+)s`).exec(web)?.[1]) * 1000;

    expect(OPS_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(OPS_TIMEOUT_MS).toBeGreaterThan(longestAnswer(OPS_UPSTREAM_TIMEOUT_MS));
    expect(readTimeout('/')).toBeGreaterThan(longestAnswer(OPS_UPSTREAM_TIMEOUT_MS));
    expect(RECONCILE_TIMEOUT_MS).toBeGreaterThan(longestAnswer(RECONCILIATION_UPSTREAM_TIMEOUT_MS));
    expect(readTimeout('= /api/ops/reconciliation')).toBeGreaterThan(
      longestAnswer(RECONCILIATION_UPSTREAM_TIMEOUT_MS),
    );
  });

  it('waits for a run that asks the engine for its progress, its period and one last recheck at full length', () => {
    const settings = readFileSync(resolve(__dirname, '../../../settlement-service/.env.example'), 'utf8');
    const engineWait = Number(/^ENGINE_TIMEOUT_MS=(\d+)$/m.exec(settings)?.[1]);
    const recheckBudget = 60_000;

    expect(engineWait).toBeGreaterThan(0);
    expect(RECONCILIATION_UPSTREAM_TIMEOUT_MS).toBeGreaterThan(3 * engineWait + recheckBudget);
  });
});
