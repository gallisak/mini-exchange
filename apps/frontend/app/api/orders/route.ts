import { NextRequest } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return withSession(request, (token) => upstream(request, 'engine', '/orders', {}, token));
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  return withSession(request, (token) =>
    upstream(
      request,
      'engine',
      '/orders',
      { method: 'POST', body, headers: { 'idempotency-key': idempotencyKey } },
      token,
    ),
  );
}
