import { NextRequest } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return withSession(request, async (accessToken) => {
    const result = await upstream(request, 'engine', '/auth/ws-ticket', { method: 'POST' }, accessToken);
    if (result.status !== 200) return result;
    return { status: 200, body: { token: (result.body as { ticket?: unknown } | null)?.ticket } };
  });
}
