import { randomUUID } from 'crypto';
import { Order } from './entities/order.entity';
import { BookSnapshot, MatchResult, Trade } from './order-book.types';
import { PRICE_SCALE, QUANTITY_SCALE, fromUnits, toUnits } from '../common/decimal';

function compareUnits(a: bigint, b: bigint): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Чиста функція зіставлення заявки з наявною книгою (price-time priority).
 * Не звертається до жодного зовнішнього стану — приймає знімок книги,
 * повертає результат. Побічні ефекти (запис у реальну книгу, персистенція)
 * — відповідальність викликача.
 */
export function matchOrder(book: BookSnapshot, incoming: Order): MatchResult {
  const trades: Trade[] = [];
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
      trades.push({
        id: randomUUID(),
        instrument: incoming.instrument,
        buyOrderId: incoming.side === 'buy' ? incoming.id : resting.id,
        sellOrderId: incoming.side === 'buy' ? resting.id : incoming.id,
        price: fromUnits(restingPrice, PRICE_SCALE), // виконання за ціною заявки, що вже стояла в книзі
        quantity: fromUnits(tradeQty, QUANTITY_SCALE),
        executedAt: new Date(),
      });

      remainingQty -= tradeQty;
      const restingRemainder = restingQty - tradeQty;

      if (restingRemainder > 0n) {
        remainingOpposite.push({
          ...resting,
          remainingQuantity: fromUnits(restingRemainder, QUANTITY_SCALE),
          status: 'partially_filled',
        });
      }
      // якщо restingRemainder === 0 — заявка повністю виконана, у книгу не повертається
    } else {
      remainingOpposite.push(resting);
    }
  }

  const restingOrder: Order | null =
    remainingQty > 0n
      ? {
          ...incoming,
          remainingQuantity: fromUnits(remainingQty, QUANTITY_SCALE),
          status:
            remainingQty < toUnits(incoming.quantity, QUANTITY_SCALE) ? 'partially_filled' : 'open',
        }
      : null;

  const same = incoming.side === 'buy' ? book.bids : book.asks;
  const updatedSame = restingOrder ? insertByPriceTimePriority(same, restingOrder) : same;

  return {
    trades,
    restingOrder,
    updatedBids: incoming.side === 'buy' ? updatedSame : remainingOpposite,
    updatedAsks: incoming.side === 'buy' ? remainingOpposite : updatedSame,
  };
}

function insertByPriceTimePriority(list: Order[], order: Order): Order[] {
  return sortByPriceTimePriority([...list, order], order.side);
}

function sortByPriceTimePriority(list: Order[], side: Order['side']): Order[] {
  const result = [...list];
  result.sort((a, b) => {
    const priceDiff =
      side === 'buy'
        ? compareUnits(toUnits(b.price, PRICE_SCALE), toUnits(a.price, PRICE_SCALE)) // bids: спадання ціни
        : compareUnits(toUnits(a.price, PRICE_SCALE), toUnits(b.price, PRICE_SCALE)); // asks: зростання ціни
    if (priceDiff !== 0) return priceDiff;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return result;
}
