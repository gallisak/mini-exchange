import { subtractDecimals } from './decimal';
import { Order, Trade } from './types';

export function mergeTrades(current: Trade[], incoming: Trade[], keep: number): Trade[] {
  const byId = new Map(current.map((trade) => [trade.id, trade]));
  for (const trade of incoming) byId.set(trade.id, trade);
  return [...byId.values()].sort((a, b) => b.seq - a.seq).slice(0, keep);
}

export function newestSeq(trades: Trade[]): number | null {
  return trades.reduce<number | null>((max, trade) => (max === null || trade.seq > max ? trade.seq : max), null);
}

export function skipsTrades(newest: number | null, trade: Trade): boolean {
  return newest !== null && trade.seq > newest + 1;
}

const FINAL: ReadonlySet<Order['status']> = new Set(['filled', 'cancelled']);

export function laterOrder(a: Order, b: Order): Order {
  if (FINAL.has(a.status) !== FINAL.has(b.status)) return FINAL.has(a.status) ? a : b;
  const difference = subtractDecimals(a.remainingQuantity, b.remainingQuantity);
  if (/^-/.test(difference) && /[1-9]/.test(difference)) return a;
  if (/[1-9]/.test(difference)) return b;
  return a.status === 'open' && b.status === 'partially_filled' ? b : a;
}

export function mergeOrders(current: Order[], incoming: Order[]): Order[] {
  const byId = new Map(current.map((order) => [order.id, order]));
  for (const order of incoming) {
    const known = byId.get(order.id);
    byId.set(order.id, known ? laterOrder(known, order) : order);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
