import { NextRequest } from 'next/server';
import { signIn } from '@/lib/server/auth-route';

export function POST(request: NextRequest) {
  return signIn(request, '/auth/register');
}
