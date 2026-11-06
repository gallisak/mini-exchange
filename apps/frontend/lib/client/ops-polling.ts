export const STATUS_REFRESH_MS = 5_000;
export const RECONCILE_REFRESH_MS = 60_000;
export const OPS_TIMEOUT_MS = 50_000;
export const RECONCILE_TIMEOUT_MS = 320_000;

export function startOpsPolling(loadStatus: () => void, reconcile: () => void): () => void {
  loadStatus();
  reconcile();
  const status = setInterval(loadStatus, STATUS_REFRESH_MS);
  const reconciliation = setInterval(reconcile, RECONCILE_REFRESH_MS);
  return () => {
    clearInterval(status);
    clearInterval(reconciliation);
  };
}

export type OpsView<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'report'; report: T; staleBecause: string | null };

export function opsView<T>(report: T | null, error: string | null): OpsView<T> {
  if (report) return { kind: 'report', report, staleBecause: error };
  return error ? { kind: 'error', message: error } : { kind: 'loading' };
}
