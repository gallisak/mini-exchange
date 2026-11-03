import { INSTRUMENTS } from '../common/instruments';
import { LEDGER_SCALE, PRICE_SCALE, QUANTITY_SCALE, toUnits } from '../common/decimal';

export const CASH_ASSET = 'USD';
export const SYSTEM_OWNER = 'system';
export const WALLET_ASSETS: readonly string[] = [CASH_ASSET, ...INSTRUMENTS];

export interface Posting {
  ownerId: string;
  asset: string;
  amount: bigint;
}

export interface TradeTerms {
  instrument: string;
  buyerId: string;
  sellerId: string;
  price: string;
  quantity: string;
}

export function displayScale(asset: string): number {
  return asset === CASH_ASSET ? PRICE_SCALE : QUANTITY_SCALE;
}

export function notional(price: string, quantity: string): bigint {
  return toUnits(price, PRICE_SCALE) * toUnits(quantity, QUANTITY_SCALE);
}

export function tradePostings(trade: TradeTerms): Posting[] {
  const cash = notional(trade.price, trade.quantity);
  const asset = toUnits(trade.quantity, LEDGER_SCALE);
  return [
    { ownerId: trade.buyerId, asset: CASH_ASSET, amount: -cash },
    { ownerId: trade.sellerId, asset: CASH_ASSET, amount: cash },
    { ownerId: trade.buyerId, asset: trade.instrument, amount: asset },
    { ownerId: trade.sellerId, asset: trade.instrument, amount: -asset },
  ];
}

const OPENING_CASH = toUnits(process.env.OPENING_CASH_BALANCE ?? '100000', LEDGER_SCALE);
const OPENING_ASSET = toUnits(process.env.OPENING_ASSET_BALANCE ?? '1000', LEDGER_SCALE);

export function openingBalance(asset: string): bigint {
  return asset === CASH_ASSET ? OPENING_CASH : OPENING_ASSET;
}

export function openingPostings(ownerId: string, asset: string): Posting[] {
  const amount = openingBalance(asset);
  return [
    { ownerId, asset, amount },
    { ownerId: SYSTEM_OWNER, asset, amount: -amount },
  ];
}

export function isBalanced(postings: Posting[]): boolean {
  const totals = new Map<string, bigint>();
  for (const posting of postings) {
    totals.set(posting.asset, (totals.get(posting.asset) ?? 0n) + posting.amount);
  }
  return [...totals.values()].every((total) => total === 0n);
}
