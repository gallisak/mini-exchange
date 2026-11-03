import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SettleTradeDto } from '../trades/dto/settle-trade.dto';

export const TRADE_EXECUTED = 'trade.executed';

export class InvalidTradeEventError extends Error {}

export function tradeStreamKey(instrument: string): string {
  return `trades:${instrument}`;
}

export function fieldsOf(raw: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) fields[raw[i]] = raw[i + 1];
  return fields;
}

export async function parseTradeEvent(fields: Record<string, string>): Promise<SettleTradeDto> {
  if (fields.type !== TRADE_EXECUTED) {
    throw new InvalidTradeEventError(`unexpected event type ${fields.type}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fields.payload);
  } catch {
    throw new InvalidTradeEventError('payload is not JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new InvalidTradeEventError('payload is not an object');
  }
  const trade = plainToInstance(SettleTradeDto, payload);
  const errors = await validate(trade, { whitelist: true });
  if (errors.length > 0) {
    throw new InvalidTradeEventError(
      errors.flatMap((error) => Object.values(error.constraints ?? {})).join('; '),
    );
  }
  return trade;
}
