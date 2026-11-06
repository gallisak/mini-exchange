import { NextRequest, NextResponse } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

const ORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  if (!ORDER_ID.test(params.id)) {
    return NextResponse.json({ message: 'Not an order id' }, { status: 400 });
  }
  return withSession(request, (token) =>
    upstream(request, 'engine', `/orders/${params.id}`, { method: 'DELETE' }, token),
  );
}
