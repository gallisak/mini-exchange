import { NextRequest } from 'next/server';
import { upstream, withSession } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return withSession(request, (token) => upstream(request, 'settlement', '/wallets/me', {}, token));
}
