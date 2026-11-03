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
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe('matchOrder', () => {
  it('sweeps price levels best first and trades at each resting price', () => {
    const asks = [
      makeOrder({ id: 'ask-102', ownerId: 'A', side: 'sell', price: '102.00' }),
      makeOrder({ id: 'ask-100', ownerId: 'C', side: 'sell', price: '100.00' }),
      makeOrder({ id: 'ask-101', ownerId: 'A', side: 'sell', price: '101.00' }),
    ];
    const incomingBuy = makeOrder({
      id: 'buy-1',
      ownerId: 'B',
      side: 'buy',
      price: '101.00',
      quantity: '3.00000000',
    });

    const result = matchOrder({ bids: [], asks }, incomingBuy);

    expect(result.trades.map((t) => [t.sellOrderId, t.price, t.quantity])).toEqual([
      ['ask-100', '100.00', '1.00000000'],
      ['ask-101', '101.00', '1.00000000'],
    ]);
    expect(result.updatedAsks.map((o) => o.id)).toEqual(['ask-102']);
    expect(result.restingOrder).toMatchObject({
      id: 'buy-1',
      remainingQuantity: '1.00000000',
      status: 'partially_filled',
    });
    expect(result.updatedBids.map((o) => o.id)).toEqual(['buy-1']);
  });

  it('matches an incoming sell against the highest bid first', () => {
    const bids = [
      makeOrder({ id: 'bid-99', ownerId: 'A', side: 'buy', price: '99.00' }),
      makeOrder({ id: 'bid-101', ownerId: 'A', side: 'buy', price: '101.00' }),
    ];
    const incomingSell = makeOrder({ id: 'sell-1', ownerId: 'B', side: 'sell', price: '98.00' });

    const result = matchOrder({ bids, asks: [] }, incomingSell);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ buyOrderId: 'bid-101', price: '101.00' });
    expect(result.updatedBids.map((o) => o.id)).toEqual(['bid-99']);
  });

  it('reports every resting order it touched with its new state', () => {
    const asks = [
      makeOrder({ id: 'ask-full', ownerId: 'A', side: 'sell', quantity: '1.00000000', createdAt: at(0) }),
      makeOrder({ id: 'ask-part', ownerId: 'C', side: 'sell', quantity: '2.00000000', createdAt: at(1) }),
      makeOrder({ id: 'ask-untouched', ownerId: 'C', side: 'sell', createdAt: at(2) }),
    ];
    const incomingBuy = makeOrder({ id: 'buy-1', ownerId: 'B', side: 'buy', quantity: '1.50000000' });

    const result = matchOrder({ bids: [], asks }, incomingBuy);

    expect(result.touchedOrders.map((o) => [o.id, o.remainingQuantity, o.status])).toEqual([
      ['ask-full', '0.00000000', 'filled'],
      ['ask-part', '1.50000000', 'partially_filled'],
    ]);
    expect(result.updatedAsks.map((o) => [o.id, o.remainingQuantity])).toEqual([
      ['ask-part', '1.50000000'],
      ['ask-untouched', '1.00000000'],
    ]);
    expect(result.incomingOrder).toMatchObject({ remainingQuantity: '0.00000000', status: 'filled' });
    expect(result.restingOrder).toBeNull();
  });

  it('rests a non-crossing order in price-time order without trading', () => {
    const bids = [
      makeOrder({ id: 'bid-100-early', ownerId: 'A', price: '100.00', createdAt: at(0) }),
      makeOrder({ id: 'bid-99', ownerId: 'A', price: '99.00', createdAt: at(1) }),
    ];
    const incomingBuy = makeOrder({ id: 'bid-100-late', ownerId: 'B', price: '100.00', createdAt: at(2) });

    const result = matchOrder(
      { bids, asks: [makeOrder({ ownerId: 'C', side: 'sell', price: '105.00' })] },
      incomingBuy,
    );

    expect(result.trades).toHaveLength(0);
    expect(result.incomingOrder.status).toBe('open');
    expect(result.updatedBids.map((o) => o.id)).toEqual(['bid-100-early', 'bid-100-late', 'bid-99']);
  });

  it('records buyer and seller on each trade', () => {
    const restingBuy = makeOrder({ id: 'bid-1', ownerId: 'buyer', side: 'buy' });
    const incomingSell = makeOrder({ id: 'ask-1', ownerId: 'seller', side: 'sell' });

    const [trade] = matchOrder({ bids: [restingBuy], asks: [] }, incomingSell).trades;

    expect(trade).toMatchObject({
      buyOrderId: 'bid-1',
      sellOrderId: 'ask-1',
      buyerId: 'buyer',
      sellerId: 'seller',
    });
  });

  it('takes trade ids and time from the context, so a replay gives the same trades', () => {
    const run = () => {
      let n = 0;
      return matchOrder(
        {
          bids: [],
          asks: [
            makeOrder({ id: 'ask-1', ownerId: 'A', side: 'sell', createdAt: at(0) }),
            makeOrder({ id: 'ask-2', ownerId: 'A', side: 'sell', createdAt: at(1) }),
          ],
        },
        makeOrder({ id: 'buy-1', ownerId: 'B', side: 'buy', quantity: '2.00000000' }),
        { nextTradeId: () => `trade-${++n}`, now: () => at(30) },
      ).trades;
    };

    const first = run();

    expect(first.map((t) => t.id)).toEqual(['trade-1', 'trade-2']);
    expect(first.every((t) => t.executedAt.getTime() === at(30).getTime())).toBe(true);
    expect(run()).toEqual(first);
  });
});
