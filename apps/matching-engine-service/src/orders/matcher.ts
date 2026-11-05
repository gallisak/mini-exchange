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

/**
 * Чиста функція зіставлення заявки з наявною книгою (price-time priority).
 * Не звертається до жодного зовнішнього стану — приймає знімок книги,
 * повертає результат. Побічні ефекти (запис у реальну книгу, персистенція)
 * — відповідальність викликача.
 */
export function matchOrder(
  book: BookSnapshot,
  incoming: Order,
  context: MatchContext = defaultContext,
): MatchResult {
  const trades: Trade[] = [];
  const touchedOrders: Order[] = [];
  const rawOpposite = incoming.side === 'buy' ? [...book.asks] : [...book.bids];
  const oppositeSide: Order['side'] = incoming.side === 'buy' ? 'sell' : 'buy';
  // Явно впорядковуємо протилежну сторону за price-time priority перед
  // матчингом — не покладаємось на те, що виклик передав уже відсортований
  // знімок книги.
  const opposite = sortByPriceTimePriority(rawOpposite, oppositeSide);
  const remainingOpposite: Order[] = [];

  const incomingPrice = toUnits(incoming.price, PRICE_SCALE);
  let remainingQty = toUnits(incoming.remainingQuantity, QUANTITY_SCALE);

  for (const resting of opposite) {
    const restingPrice = toUnits(resting.price, PRICE_SCALE);
    const priceCrosses =
      incoming.side === 'buy' ? incomingPrice >= restingPrice : incomingPrice <= restingPrice;

    // Self-trade prevention: заявки одного власника не зіставляються.
    const sameOwner = resting.ownerId === incoming.ownerId;

    if (remainingQty > 0n && priceCrosses && !sameOwner) {
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
        price: fromUnits(restingPrice, PRICE_SCALE), // виконання за ціною заявки, що вже стояла в книзі
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
      // якщо restingRemainder === 0 — заявка повністю виконана, у книгу не повертається
    } else {
      remainingOpposite.push(resting);
    }
  }

  const incomingOrder: Order = {
    ...incoming,
    remainingQuantity: fromUnits(remainingQty, QUANTITY_SCALE),
    status:
      remainingQty === 0n
        ? 'filled'
        : remainingQty < toUnits(incoming.quantity, QUANTITY_SCALE)
          ? 'partially_filled'
          : 'open',
  };
  const restingOrder: Order | null = remainingQty > 0n ? incomingOrder : null;

  const same = incoming.side === 'buy' ? book.bids : book.asks;
  const updatedSame = restingOrder ? insertByPriceTimePriority(same, restingOrder) : same;

  return {
    trades,
    restingOrder,
    incomingOrder,
    touchedOrders,
    updatedBids: incoming.side === 'buy' ? updatedSame : remainingOpposite,
    updatedAsks: incoming.side === 'buy' ? remainingOpposite : updatedSame,
  };
}

function insertByPriceTimePriority(list: Order[], order: Order): Order[] {
  return sortByPriceTimePriority([...list, order], order.side);
}

export function sortByPriceTimePriority(list: Order[], side: Order['side']): Order[] {
  const keyed = list.map((order) => ({
    order,
    price: toUnits(order.price, PRICE_SCALE),
    seq: order.seq != null ? BigInt(order.seq) : null,
  }));
  keyed.sort((a, b) => {
    const priceDiff =
      side === 'buy'
        ? compareUnits(b.price, a.price) // bids: спадання ціни
        : compareUnits(a.price, b.price); // asks: зростання ціни
    if (priceDiff !== 0) return priceDiff;
    if (a.seq !== null && b.seq !== null) return compareUnits(a.seq, b.seq);
    return a.order.createdAt.getTime() - b.order.createdAt.getTime();
  });
  return keyed.map(({ order }) => order);
}
