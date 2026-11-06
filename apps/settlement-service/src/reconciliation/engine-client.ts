import { Injectable } from '@nestjs/common';
import { LEDGER_SCALE, toUnits } from '../common/decimal';
import { intEnv } from '../common/env';

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

export interface EngineProgress {
  firstTradeAt: Date | null;
  pendingSince: Date | null;
}

function dateOf(value: unknown): Date | null {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

@Injectable()
export class EngineClient {
  private readonly timeoutMs = intEnv('ENGINE_TIMEOUT_MS', 30_000);

  async tradeTotals(from: Date, to: Date): Promise<EngineInstrumentTotals[]> {
    return (await this.summary(from, to)).instruments;
  }

  async progress(): Promise<EngineProgress> {
    const { firstTradeAt, pendingSince } = await this.summary(new Date(0), new Date(1));
    return { firstTradeAt, pendingSince };
  }

  private async summary(
    from: Date,
    to: Date,
  ): Promise<{ instruments: EngineInstrumentTotals[] } & EngineProgress> {
    const url = new URL('/trades/summary', process.env.ENGINE_URL ?? 'http://localhost:3001');
    url.searchParams.set('from', from.toISOString());
    url.searchParams.set('to', to.toISOString());
    const response = await fetch(url, {
      headers: { 'x-internal-key': process.env.ENGINE_INTERNAL_KEY ?? '' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Engine answered ${response.status} for the trade summary`);
    }
    const body = (await response.json().catch(() => null)) as {
      instruments?: unknown;
      firstTradeAt?: unknown;
      pendingSince?: unknown;
    } | null;
    if (!Array.isArray(body?.instruments) || !body.instruments.every(isTotals)) {
      throw new Error('Engine returned a malformed trade summary');
    }
    return {
      instruments: body.instruments,
      firstTradeAt: dateOf(body.firstTradeAt),
      pendingSince: dateOf(body.pendingSince),
    };
  }
}
