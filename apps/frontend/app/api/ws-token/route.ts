import { NextRequest } from 'next/server';
import { issueWsToken } from '@/lib/server/ws-token';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return issueWsToken(request);
}
