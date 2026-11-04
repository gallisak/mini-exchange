import { NextRequest } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

export function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  return withSession(request, (token) =>
    upstream(request, 'engine', `/orders/${encodeURIComponent(params.id)}`, { method: 'DELETE' }, token),
  );
}
