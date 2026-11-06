import { NextRequest, NextResponse } from 'next/server';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function fromAnotherSite(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.get('host');
  } catch {
    return true;
  }
}

export function middleware(request: NextRequest) {
  if (!READS.has(request.method) && fromAnotherSite(request)) {
    return NextResponse.json({ message: 'Requests from other sites are not accepted' }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
