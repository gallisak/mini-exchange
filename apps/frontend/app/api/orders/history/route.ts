import { NextRequest, NextResponse } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const before = request.nextUrl.searchParams.get('before') ?? '';
  const beforeId = request.nextUrl.searchParams.get('beforeId') ?? '';
  if (Number.isNaN(Date.parse(before)) || !ORDER_ID.test(beforeId)) {
    return NextResponse.json({ message: 'Name the oldest finished order shown' }, { status: 400 });
  }
  const query = new URLSearchParams({ before, beforeId });
  return withSession(request, (token) => upstream(request, 'engine', `/orders/history?${query}`, {}, token));
}
