import { NextRequest } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const RECONCILIATION_TIMEOUT_MS = 300_000;

export function GET(request: NextRequest) {
  return withSession(request, (token) =>
    upstream(request, 'settlement', '/admin/reconciliation', { timeoutMs: RECONCILIATION_TIMEOUT_MS }, token),
  );
}
