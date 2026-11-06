import { NextRequest, NextResponse } from 'next/server';
import { upstream, withSession } from './upstream';

export function issueWsToken(request: NextRequest): Promise<NextResponse> {
  return withSession(request, async (accessToken) => {
    const result = await upstream(request, 'engine', '/auth/ws-ticket', { method: 'POST' }, accessToken);
    if (result.status === 404) {
      return { status: 503, body: { message: 'The engine does not issue real-time tickets yet' } };
    }
    if (result.status !== 200) return result;
    return { status: 200, body: { token: (result.body as { ticket?: unknown } | null)?.ticket } };
  });
}
