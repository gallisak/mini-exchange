import { matchOrder } from '../src/orders/matcher';
import { Order } from '../src/orders/entities/order.entity';

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: overrides.id ?? 'order-' + Math.random(),
    ownerId: overrides.ownerId ?? 'owner-1',
    instrument: overrides.instrument ?? 'ABC',
    side: overrides.side ?? 'buy',
    price: overrides.price ?? '100.00',
    quantity: overrides.quantity ?? '1.00000000',
    remainingQuantity: overrides.remainingQuantity ?? overrides.quantity ?? '1.00000000',
    status: overrides.status ?? 'open',
    createdAt: overrides.createdAt ?? new Date(),
  };
}

describe('matcher precision', () => {
  it('trades the largest quantity numeric(18,8) can hold without rounding', () => {
    const quantity = '9999999999.99999999';
    const restingSell = makeOrder({ id: 'sell-1', ownerId: 'owner-A', side: 'sell', quantity });
    const incomingBuy = makeOrder({ id: 'buy-1', ownerId: 'owner-B', side: 'buy', quantity });

    const result = matchOrder({ bids: [], asks: [restingSell] }, incomingBuy);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe(quantity);
    expect(result.restingOrder).toBeNull();
    expect(result.updatedAsks).toHaveLength(0);
  });

  it('does not cross when a large bid is one cent below the ask', () => {
    const restingSell = makeOrder({
      id: 'sell-1',
      ownerId: 'owner-A',
      side: 'sell',
      price: '9999999999999999.99',
    });
    const incomingBuy = makeOrder({
      id: 'buy-1',
      ownerId: 'owner-B',
      side: 'buy',
      price: '9999999999999999.98',
    });

    const result = matchOrder({ bids: [], asks: [restingSell] }, incomingBuy);

    expect(result.trades).toHaveLength(0);
    expect(result.updatedAsks).toHaveLength(1);
    expect(result.updatedBids.map((o) => o.id)).toEqual(['buy-1']);
  });

  it('leaves exactly nothing after three fills of 0.1 against 0.3', () => {
    let book = {
      bids: [] as Order[],
      asks: [makeOrder({ id: 'sell-1', ownerId: 'owner-A', side: 'sell', quantity: '0.30000000' })],
    };
    for (let i = 0; i < 3; i++) {
      const result = matchOrder(
        book,
        makeOrder({ id: `buy-${i}`, ownerId: 'owner-B', side: 'buy', quantity: '0.10000000' }),
      );
      book = { bids: result.updatedBids, asks: result.updatedAsks };
    }

    expect(book.asks).toHaveLength(0);
    expect(book.bids).toHaveLength(0);
  });
});
