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

describe('self-trade prevention', () => {
  it('does not match two orders from the same owner, and cancels the new one instead of resting it across the other', () => {
    const restingSell = makeOrder({
      id: 'sell-1',
      ownerId: 'same-owner',
      side: 'sell',
      price: '100.00',
      quantity: '1.00000000',
    });
    const incomingBuy = makeOrder({
      id: 'buy-1',
      ownerId: 'same-owner',
      side: 'buy',
      price: '100.00',
      quantity: '1.00000000',
    });

    const result = matchOrder({ bids: [], asks: [restingSell] }, incomingBuy);

    expect(result.trades).toHaveLength(0);
    expect(result.updatedAsks).toEqual([restingSell]);
    expect(result.updatedBids).toEqual([]);
    expect(result.restingOrder).toBeNull();
    expect(result.incomingOrder).toMatchObject({ id: 'buy-1', remainingQuantity: '1.00000000', status: 'cancelled' });
  });

  it('trades with better counterparties first, then cancels the rest once it reaches its own order', () => {
    const otherSell = makeOrder({ id: 'other-sell', ownerId: 'other-owner', side: 'sell', price: '99.00' });
    const ownSell = makeOrder({ id: 'own-sell', ownerId: 'same-owner', side: 'sell', price: '100.00' });
    const incomingBuy = makeOrder({
      id: 'buy-1',
      ownerId: 'same-owner',
      side: 'buy',
      price: '101.00',
      quantity: '2.00000000',
    });

    const result = matchOrder({ bids: [], asks: [otherSell, ownSell] }, incomingBuy);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ buyOrderId: 'buy-1', sellOrderId: 'other-sell', price: '99.00' });
    expect(result.updatedAsks).toEqual([ownSell]);
    expect(result.restingOrder).toBeNull();
    expect(result.incomingOrder).toMatchObject({ remainingQuantity: '1.00000000', status: 'cancelled' });
  });

  it('does not trade past its own order with a counterparty that comes after it', () => {
    const ownSell = makeOrder({
      id: 'own-sell',
      ownerId: 'same-owner',
      side: 'sell',
      price: '100.00',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const otherSell = makeOrder({
      id: 'other-sell',
      ownerId: 'other-owner',
      side: 'sell',
      price: '101.00',
      createdAt: new Date('2026-01-01T00:00:05Z'),
    });
    const incomingBuy = makeOrder({ id: 'buy-1', ownerId: 'same-owner', side: 'buy', price: '101.00' });

    const result = matchOrder({ bids: [], asks: [ownSell, otherSell] }, incomingBuy);

    expect(result.trades).toHaveLength(0);
    expect(result.updatedAsks).toEqual([ownSell, otherSell]);
    expect(result.updatedBids).toEqual([]);
    expect(result.incomingOrder.status).toBe('cancelled');
  });
});
