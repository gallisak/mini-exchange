export const STATUS_REFRESH_MS = 5_000;
export const RECONCILE_REFRESH_MS = 60_000;

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
