import { StreamCommand } from '../src/orders/engine/order-command';

export interface ReferenceTrade {
  buyOrderId: string;
  sellOrderId: string;
  price: bigint;
  quantity: bigint;
}

export interface ReferenceOrder {
  id: string;
  ownerId: string;
  side: 'buy' | 'sell';
  price: bigint;
  remaining: bigint;
  arrival: number;
}

export interface ReferenceResult {
  trades: ReferenceTrade[];
  bids: ReferenceOrder[];
  asks: ReferenceOrder[];
}

function units(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale));
}

function crosses(incoming: ReferenceOrder, resting: ReferenceOrder): boolean {
  return incoming.side === 'buy' ? resting.price <= incoming.price : resting.price >= incoming.price;
}

function better(side: 'buy' | 'sell', a: ReferenceOrder, b: ReferenceOrder): ReferenceOrder {
  if (a.price !== b.price) {
    const aIsBetter = side === 'sell' ? a.price < b.price : a.price > b.price;
    return aIsBetter ? a : b;
  }
  return a.arrival < b.arrival ? a : b;
}

function byPriority(side: 'buy' | 'sell', orders: ReferenceOrder[]): ReferenceOrder[] {
  const remaining = [...orders];
  const ordered: ReferenceOrder[] = [];
  while (remaining.length > 0) {
    const best = remaining.reduce((a, b) => better(side, a, b));
    ordered.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }
  return ordered;
}

export function referenceMatch(commands: StreamCommand[]): ReferenceResult {
  const book: ReferenceOrder[] = [];
  const trades: ReferenceTrade[] = [];
  const seen = new Set<string>();
  let arrival = 0;

  for (const { command } of commands) {
    if (!command) continue;
    if (command.type === 'cancel') {
      const index = book.findIndex(
        (order) => order.id === command.orderId && order.ownerId === command.ownerId,
      );
      if (index >= 0) book.splice(index, 1);
      continue;
    }
    if (seen.has(command.orderId)) continue;
    seen.add(command.orderId);
    const incoming: ReferenceOrder = {
      id: command.orderId,
      ownerId: command.ownerId,
      side: command.side,
      price: units(command.price, 2),
      remaining: units(command.quantity, 8),
      arrival: arrival++,
    };
    const opposite = incoming.side === 'buy' ? 'sell' : 'buy';
    let reachedOwnOrder = false;
    while (incoming.remaining > 0n) {
      const candidates = book.filter((order) => order.side === opposite && crosses(incoming, order));
      if (candidates.length === 0) break;
      const resting = candidates.reduce((a, b) => better(opposite, a, b));
      if (resting.ownerId === incoming.ownerId) {
        reachedOwnOrder = true;
        break;
      }
      const quantity = resting.remaining < incoming.remaining ? resting.remaining : incoming.remaining;
      trades.push({
        buyOrderId: incoming.side === 'buy' ? incoming.id : resting.id,
        sellOrderId: incoming.side === 'sell' ? incoming.id : resting.id,
        price: resting.price,
        quantity,
      });
      resting.remaining -= quantity;
      incoming.remaining -= quantity;
      if (resting.remaining === 0n) book.splice(book.indexOf(resting), 1);
    }
    if (incoming.remaining > 0n && !reachedOwnOrder) book.push(incoming);
  }

  return {
    trades,
    bids: byPriority(
      'buy',
      book.filter((order) => order.side === 'buy'),
    ),
    asks: byPriority(
      'sell',
      book.filter((order) => order.side === 'sell'),
    ),
  };
}

export function crossedPairs(result: ReferenceResult): [string, string][] {
  const pairs: [string, string][] = [];
  for (const bid of result.bids) {
    for (const ask of result.asks) {
      if (bid.price >= ask.price) pairs.push([bid.id, ask.id]);
    }
  }
  return pairs;
}

export function asReference(
  trades: { buyOrderId: string; sellOrderId: string; price: string; quantity: string }[],
  bids: { id: string; ownerId: string; price: string; remainingQuantity: string }[],
  asks: { id: string; ownerId: string; price: string; remainingQuantity: string }[],
): ReferenceResult {
  const order =
    (side: 'buy' | 'sell') =>
    (o: { id: string; ownerId: string; price: string; remainingQuantity: string }, i: number) => ({
      id: o.id,
      ownerId: o.ownerId,
      side,
      price: units(o.price, 2),
      remaining: units(o.remainingQuantity, 8),
      arrival: i,
    });
  return {
    trades: trades.map((t) => ({
      buyOrderId: t.buyOrderId,
      sellOrderId: t.sellOrderId,
      price: units(t.price, 2),
      quantity: units(t.quantity, 8),
    })),
    bids: bids.map(order('buy')),
    asks: asks.map(order('sell')),
  };
}
