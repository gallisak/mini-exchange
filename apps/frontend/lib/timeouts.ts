export const UPSTREAM_TIMEOUT_MS = 10_000;
export const END_SESSION_TIMEOUT_MS = 2_000;
export const OPS_UPSTREAM_TIMEOUT_MS = 15_000;
export const RECONCILIATION_UPSTREAM_TIMEOUT_MS = 290_000;
export const OPS_TIMEOUT_MS = 55_000;
export const RECONCILE_TIMEOUT_MS = 620_000;

export const longestAnswer = (callMs: number) => 2 * UPSTREAM_TIMEOUT_MS + 2 * callMs;
