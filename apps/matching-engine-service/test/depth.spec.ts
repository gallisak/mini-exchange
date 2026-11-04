import { aggregate, diffBooks } from '../src/orders/depth';
import { Order } from '../src/orders/entities/order.entity';

let next = 0;
function order(side: 'buy' | 'sell', price: string, remainingQuantity: string): Order {
  next += 1;
  return {
    id: `order-${next}`,
    ownerId: `owner-${next}`,
    instrument: 'ABC',
    side,
    price,
    quantity: remainingQuantity,
    remainingQuantity,
    status: 'open',
    createdAt: new Date(0),
  };
}

describe('order book depth', () => {
  it('aggregates resting orders into price levels in book order', () => {
    const depth = aggregate({
      bids: [order('buy', '99.00', '1'), order('buy', '100.00', '0.5'), order('buy', '99', '2')],
      asks: [order('sell', '101.50', '0.00000001'), order('sell', '101.00', '3')],
    });

    expect(depth).toEqual({
      bids: [
        { price: '100.00', quantity: '0.50000000', orders: 1 },
        { price: '99.00', quantity: '3.00000000', orders: 2 },
      ],
      asks: [
        { price: '101.00', quantity: '3.00000000', orders: 1 },
        { price: '101.50', quantity: '0.00000001', orders: 1 },
      ],
    });
  });

  it('reports only the levels that changed, with removed levels at zero', () => {
    const kept = order('buy', '99.00', '1');
    const filled = order('sell', '101.00', '1');
    const before = { bids: [kept, order('buy', '98.00', '1')], asks: [filled] };
    const after = {
      bids: [kept, order('buy', '98.00', '0.4'), order('buy', '97.00', '2')],
      asks: [],
    };

    expect(diffBooks(before, after)).toEqual([
      { side: 'buy', price: '98.00', quantity: '0.40000000', orders: 1 },
      { side: 'buy', price: '97.00', quantity: '2.00000000', orders: 1 },
      { side: 'sell', price: '101.00', quantity: '0.00000000', orders: 0 },
    ]);
  });

  it('reports a level whose order count changed even if its quantity did not', () => {
    const before = { bids: [order('buy', '99.00', '2')], asks: [] };
    const after = { bids: [order('buy', '99.00', '1'), order('buy', '99.00', '1')], asks: [] };

    expect(diffBooks(before, after)).toEqual([
      { side: 'buy', price: '99.00', quantity: '2.00000000', orders: 2 },
    ]);
  });

  it('reports nothing when the levels are the same', () => {
    const book = { bids: [order('buy', '99.00', '1')], asks: [order('sell', '100.00', '1')] };

    expect(diffBooks(book, { bids: [...book.bids], asks: [...book.asks] })).toEqual([]);
  });
});
