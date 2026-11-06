import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CancelledRemaining1793790000000 } from '../../src/database/migrations/1793790000000-CancelledRemaining';
import { cancel, createApp, eventually, listOrders, register, resetState, submit } from './harness';

describe('cancelling a partially filled order', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  async function partiallyFilledThenCancelled() {
    const [seller, buyer] = [await register(app), await register(app)];
    const sell = await submit(app, seller, { side: 'sell', price: '100.00', quantity: '5' }).expect(202);
    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' }).expect(202);
    await eventually(async () =>
      expect((await listOrders(app, seller))[0]?.status).toBe('partially_filled'),
    );
    await cancel(app, seller, sell.body.orderId).expect(202);
    await eventually(async () =>
      expect((await listOrders(app, seller))[0]?.status).toBe('cancelled'),
    );
    return seller;
  }

  it('keeps how much of it was filled', async () => {
    const seller = await partiallyFilledThenCancelled();

    expect(await listOrders(app, seller)).toEqual([
      expect.objectContaining({ quantity: '5.00000000', remainingQuantity: '4.00000000' }),
    ]);
  });

  it('restores the filled part of orders cancelled before the fix from their trades', async () => {
    const seller = await partiallyFilledThenCancelled();
    const dataSource = app.get(DataSource);
    await dataSource.query(`UPDATE orders SET "remainingQuantity" = 0 WHERE status = 'cancelled'`);
    const runner = dataSource.createQueryRunner();

    await new CancelledRemaining1793790000000().up(runner);
    await runner.release();

    expect((await listOrders(app, seller))[0].remainingQuantity).toBe('4.00000000');
  });

  it('answers a repeated cancel of an order it already cancelled as accepted, so a retried request does not look like a failure', async () => {
    const seller = await partiallyFilledThenCancelled();
    const [order] = await listOrders(app, seller);

    await cancel(app, seller, order.id).expect(202);
  });
});
