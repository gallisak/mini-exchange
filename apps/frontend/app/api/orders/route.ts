import { NextRequest, NextResponse } from 'next/server';
import { engineFetch } from '@/lib/api';

// NOTE (стартовий код): проксі поки що без передачі Authorization —
// автентифікацію на фронтенді потрібно підключити (див. ТЗ щодо
// перенесеного модуля автентифікації).
export async function POST(req: NextRequest) {
  const body = await req.json();
  const idempotencyKey = req.headers.get('idempotency-key');
  try {
    const accepted = await engineFetch('/orders', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify(body),
    });
    return NextResponse.json(accepted, { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
