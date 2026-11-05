import { Injectable } from '@nestjs/common';
import { LEDGER_SCALE, toUnits } from '../common/decimal';

export interface EngineInstrumentTotals {
  instrument: string;
  count: number;
  quantity: string;
  notional: string;
}

const isAmount = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    return toUnits(value, LEDGER_SCALE) >= 0n;
  } catch {
    return false;
  }
};

function isTotals(value: unknown): value is EngineInstrumentTotals {
  const row = value as Partial<EngineInstrumentTotals> | null;
  return (
    typeof row === 'object' &&
    row !== null &&
    typeof row.instrument === 'string' &&
    Number.isSafeInteger(row.count) &&
    (row.count as number) >= 0 &&
    isAmount(row.quantity) &&
    isAmount(row.notional)
  );
}

@Injectable()
export class EngineClient {
  async tradeTotals(from: Date, to: Date): Promise<EngineInstrumentTotals[]> {
    const url = new URL('/trades/summary', process.env.ENGINE_URL ?? 'http://localhost:3001');
    url.searchParams.set('from', from.toISOString());
    url.searchParams.set('to', to.toISOString());
    const response = await fetch(url, {
      headers: { 'x-internal-key': process.env.ENGINE_INTERNAL_KEY ?? '' },
      signal: AbortSignal.timeout(Number(process.env.ENGINE_TIMEOUT_MS ?? 5000)),
    });
    if (!response.ok) {
      throw new Error(`Engine answered ${response.status} for the trade summary`);
    }
    const body = (await response.json().catch(() => null)) as { instruments?: unknown } | null;
    if (!Array.isArray(body?.instruments) || !body.instruments.every(isTotals)) {
      throw new Error('Engine returned a malformed trade summary');
    }
    return body.instruments;
  }
}
