import { NextRequest } from 'next/server';
import { relay, upstream } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const instrument = request.nextUrl.searchParams.get('instrument') ?? '';
  return relay(
    await upstream(
      request,
      'engine',
      `/trades?instrument=${encodeURIComponent(instrument)}&limit=50`,
    ),
  );
}
