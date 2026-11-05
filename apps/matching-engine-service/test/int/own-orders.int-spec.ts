import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createApp, eventually, listOrders, range, register, resetState, submit } from './harness';

describe('listing own orders', () => {
  let app: INestApplication;
  const limit = process.env.ORDER_HISTORY_LIMIT;

  beforeEach(async () => {
    await resetState();
    process.env.ORDER_HISTORY_LIMIT = '2';
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
    process.env.ORDER_HISTORY_LIMIT = limit;
  });

  it('returns every active order but only the latest finished ones', async () => {
    const [trader, other] = [await register(app), await register(app)];
    const oldest = await submit(app, trader, { side: 'buy', price: '1.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(await listOrders(app, trader)).toHaveLength(1));
    for (const i of range(4)) {
      await submit(app, other, { side: 'buy', price: '50.00', quantity: '1' }).expect(202);
      await submit(app, trader, { side: 'sell', price: '50.00', quantity: '1' }).expect(202);
      await eventually(async () =>
        expect(await app.get(DataSource).query('SELECT id FROM trades')).toHaveLength(i + 1),
      );
    }

    const own = await listOrders(app, trader);

    expect(own.map((order) => order.status)).toEqual(['filled', 'filled', 'open']);
    expect(own[2].id).toBe(oldest.body.orderId);
  });
});
