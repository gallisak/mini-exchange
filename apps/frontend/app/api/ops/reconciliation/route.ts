import { NextRequest } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';
import { RECONCILIATION_UPSTREAM_TIMEOUT_MS } from '@/lib/timeouts';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return withSession(request, (token) =>
    upstream(request, 'settlement', '/admin/reconciliation', { timeoutMs: RECONCILIATION_UPSTREAM_TIMEOUT_MS }, token),
  );
}
