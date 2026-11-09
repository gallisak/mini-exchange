import { randomUUID } from 'crypto';
import { Order } from './entities/order.entity';
import { BookSnapshot, MatchContext, MatchResult, Trade } from './order-book.types';
import { PRICE_SCALE, QUANTITY_SCALE, fromUnits, toUnits } from '../common/decimal';

const defaultContext: MatchContext = {
  nextTradeId: () => randomUUID(),
  now: () => new Date(),
};

function compareUnits(a: bigint, b: bigint): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function matchOrder(
  book: BookSnapshot,
  incoming: Order,
  context: MatchContext = defaultContext,
): MatchResult {
  const trades: Trade[] = [];
  const touchedOrders: Order[] = [];
  const rawOpposite = incoming.side === 'buy' ? book.asks : book.bids;
  const oppositeSide: Order['side'] = incoming.side === 'buy' ? 'sell' : 'buy';
  const opposite = inPriceTimePriority(rawOpposite, oppositeSide);
  const remainingOpposite: Order[] = [];

  const incomingPrice = toUnits(incoming.price, PRICE_SCALE);
  let remainingQty = toUnits(incoming.remainingQuantity, QUANTITY_SCALE);

  let reachedOwnOrder = false;
  let index = 0;
  for (; index < opposite.length && remainingQty > 0n; index++) {
    const resting = opposite[index];
    const restingPrice = toUnits(resting.price, PRICE_SCALE);
    const priceCrosses =
      incoming.side === 'buy' ? incomingPrice >= restingPrice : incomingPrice <= restingPrice;
    if (!priceCrosses) break;
    if (resting.ownerId === incoming.ownerId) {
      reachedOwnOrder = true;
      break;
    }

    const restingQty = toUnits(resting.remainingQuantity, QUANTITY_SCALE);
    const tradeQty = remainingQty < restingQty ? remainingQty : restingQty;
    const buyer = incoming.side === 'buy' ? incoming : resting;
    const seller = incoming.side === 'buy' ? resting : incoming;
    trades.push({
      id: context.nextTradeId(),
      instrument: incoming.instrument,
      buyOrderId: buyer.id,
      sellOrderId: seller.id,
      buyerId: buyer.ownerId,
      sellerId: seller.ownerId,
      price: fromUnits(restingPrice, PRICE_SCALE),
      quantity: fromUnits(tradeQty, QUANTITY_SCALE),
      executedAt: context.now(),
    });

    remainingQty -= tradeQty;
    const restingRemainder = restingQty - tradeQty;
    const touched: Order = {
      ...resting,
      remainingQuantity: fromUnits(restingRemainder, QUANTITY_SCALE),
      status: restingRemainder > 0n ? 'partially_filled' : 'filled',
    };
    touchedOrders.push(touched);

    if (restingRemainder > 0n) {
      remainingOpposite.push(touched);
    }
  }

  const incomingOrder: Order = {
    ...incoming,
    remainingQuantity: fromUnits(remainingQty, QUANTITY_SCALE),
    status:
      remainingQty === 0n
        ? 'filled'
        : reachedOwnOrder
          ? 'cancelled'
          : remainingQty < toUnits(incoming.quantity, QUANTITY_SCALE)
            ? 'partially_filled'
            : 'open',
  };
  const restingOrder: Order | null = remainingQty > 0n && !reachedOwnOrder ? incomingOrder : null;

  const restOfOpposite = index === 0 ? opposite : remainingOpposite.concat(opposite.slice(index));
  sorted.add(restOfOpposite);

  const same = incoming.side === 'buy' ? book.bids : book.asks;
  const updatedSame = restingOrder
    ? insertByPriceTimePriority(inPriceTimePriority(same, incoming.side), restingOrder)
    : same;

  return {
    trades,
    restingOrder,
    incomingOrder,
    touchedOrders,
    updatedBids: incoming.side === 'buy' ? updatedSame : restOfOpposite,
    updatedAsks: incoming.side === 'buy' ? restOfOpposite : updatedSame,
  };
}

const sorted = new WeakSet<Order[]>();

function priorityKey(order: Order) {
  return {
    order,
    price: toUnits(order.price, PRICE_SCALE),
    seq: order.seq != null ? BigInt(order.seq) : null,
  };
}

type PriorityKey = ReturnType<typeof priorityKey>;

function comparePriority(side: Order['side'], a: PriorityKey, b: PriorityKey): number {
  const priceDiff =
    side === 'buy'
      ? compareUnits(b.price, a.price)
      : compareUnits(a.price, b.price);
  if (priceDiff !== 0) return priceDiff;
  if (a.seq !== null && b.seq !== null) return compareUnits(a.seq, b.seq);
  return a.order.createdAt.getTime() - b.order.createdAt.getTime();
}

function inPriceTimePriority(list: Order[], side: Order['side']): Order[] {
  return sorted.has(list) ? list : sortByPriceTimePriority(list, side);
}

function insertByPriceTimePriority(list: Order[], order: Order): Order[] {
  const key = priorityKey(order);
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comparePriority(order.side, priorityKey(list[middle]), key) <= 0) low = middle + 1;
    else high = middle;
  }
  const result = [...list.slice(0, low), order, ...list.slice(low)];
  sorted.add(result);
  return result;
}

export function withoutOrder(list: Order[], orderId: string): Order[] {
  const result = list.filter((order) => order.id !== orderId);
  if (sorted.has(list)) sorted.add(result);
  return result;
}

export function sortByPriceTimePriority(list: Order[], side: Order['side']): Order[] {
  const keyed = list.map(priorityKey);
  keyed.sort((a, b) => comparePriority(side, a, b));
  const result = keyed.map(({ order }) => order);
  sorted.add(result);
  return result;
}
