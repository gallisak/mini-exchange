import { NextRequest } from 'next/server';
import { UpstreamResult, upstream, withSession } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

const part = ({ status, body }: UpstreamResult) =>
  status === 200 ? { ok: true, data: body } : { ok: false, status, error: body };

export function GET(request: NextRequest) {
  return withSession(request, async (token) => {
    const [engine, settlement, reconciliation] = await Promise.all([
      upstream(request, 'engine', '/ops/status', {}, token),
      upstream(request, 'settlement', '/ops/status', {}, token),
      upstream(request, 'settlement', '/admin/reconciliation', {}, token),
    ]);
    const denied = [engine, settlement, reconciliation].find(
      (result) => result.status === 401 || result.status === 403,
    );
    if (denied) return denied;
    return {
      status: 200,
      body: {
        engine: part(engine),
        settlement: part(settlement),
        reconciliation: part(reconciliation),
      },
    };
  });
}
