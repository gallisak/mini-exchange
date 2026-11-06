import { NextRequest } from 'next/server';
import { UpstreamResult, upstream, withSession } from '@/lib/server/upstream';
import { OPS_UPSTREAM_TIMEOUT_MS } from '@/lib/timeouts';

export const dynamic = 'force-dynamic';

const part = ({ status, body }: UpstreamResult) =>
  status === 200 ? { ok: true, data: body } : { ok: false, status, error: body };

export function GET(request: NextRequest) {
  return withSession(request, async (token) => {
    const [engine, settlement] = await Promise.all([
      upstream(request, 'engine', '/ops/status', { timeoutMs: OPS_UPSTREAM_TIMEOUT_MS }, token),
      upstream(request, 'settlement', '/ops/status', { timeoutMs: OPS_UPSTREAM_TIMEOUT_MS }, token),
    ]);
    if (engine.status === 401 || engine.status === 403) return engine;
    return { status: 200, body: { engine: part(engine), settlement: part(settlement) } };
  });
}
