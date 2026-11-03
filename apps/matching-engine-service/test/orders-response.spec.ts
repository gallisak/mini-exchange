import { Repository } from 'typeorm';
import { OrdersService } from '../src/orders/orders.service';
import { OrderBookService } from '../src/orders/order-book.service';
import { Order } from '../src/orders/entities/order.entity';

function inMemoryRepository() {
  return {
    create: (order: Order) => order,
    save: async (order: Order) => order,
  } as unknown as Repository<Order>;
}

describe('submit order response', () => {
  it('does not reveal who the counterparty is', async () => {
    const service = new OrdersService(inMemoryRepository(), new OrderBookService());
    await service.submitOrder(
      { instrument: 'ABC', side: 'sell', price: '100.00', quantity: '1' },
      'seller-id',
    );

    const trades = await service.submitOrder(
      { instrument: 'ABC', side: 'buy', price: '100.00', quantity: '1' },
      'buyer-id',
    );

    expect(trades).toHaveLength(1);
    expect(trades[0]).not.toHaveProperty('buyerId');
    expect(trades[0]).not.toHaveProperty('sellerId');
    expect(JSON.stringify(trades)).not.toContain('seller-id');
  });
});
