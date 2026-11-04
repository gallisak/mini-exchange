import { Order } from './entities/order.entity';
import { BookSnapshot } from './order-book.types';
import { PRICE_SCALE, QUANTITY_SCALE, fromUnits, toUnits } from '../common/decimal';

export type Side = 'buy' | 'sell';

export interface DepthLevel {
  price: string;
  quantity: string;
  orders: number;
}

export interface Depth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface LevelChange extends DepthLevel {
  side: Side;
}

interface LevelUnits {
  price: bigint;
  quantity: bigint;
  orders: number;
}

function levels(orders: Order[], side: Side): Map<bigint, LevelUnits> {
  const byPrice = new Map<bigint, LevelUnits>();
  for (const order of orders) {
    const price = toUnits(order.price, PRICE_SCALE);
    const level = byPrice.get(price) ?? { price, quantity: 0n, orders: 0 };
    level.quantity += toUnits(order.remainingQuantity, QUANTITY_SCALE);
    level.orders += 1;
    byPrice.set(price, level);
  }
  const ordered = [...byPrice.values()].sort((a, b) =>
    side === 'buy' ? Number(b.price - a.price) : Number(a.price - b.price),
  );
  return new Map(ordered.map((level) => [level.price, level]));
}

const toLevel = ({ price, quantity, orders }: LevelUnits): DepthLevel => ({
  price: fromUnits(price, PRICE_SCALE),
  quantity: fromUnits(quantity, QUANTITY_SCALE),
  orders,
});

export function aggregate(book: BookSnapshot): Depth {
  return {
    bids: [...levels(book.bids, 'buy').values()].map(toLevel),
    asks: [...levels(book.asks, 'sell').values()].map(toLevel),
  };
}

function sideChanges(before: Order[], after: Order[], side: Side): LevelChange[] {
  const previous = levels(before, side);
  const next = levels(after, side);
  const prices = [...new Set([...previous.keys(), ...next.keys()])].sort((a, b) =>
    side === 'buy' ? Number(b - a) : Number(a - b),
  );
  return prices.flatMap((price) => {
    const was = previous.get(price);
    const now = next.get(price) ?? { price, quantity: 0n, orders: 0 };
    if (was && was.quantity === now.quantity && was.orders === now.orders) return [];
    return [{ side, ...toLevel(now) }];
  });
}

export function diffBooks(before: BookSnapshot, after: BookSnapshot): LevelChange[] {
  return [...sideChanges(before.bids, after.bids, 'buy'), ...sideChanges(before.asks, after.asks, 'sell')];
}
