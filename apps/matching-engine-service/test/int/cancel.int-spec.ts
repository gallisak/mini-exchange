import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { CancelledRemaining1793790000000 } from '../../src/database/migrations/1793790000000-CancelledRemaining';
import { instrumentLockKey } from '../../src/orders/engine/instrument-ownership.service';
import { cancel, createApp, eventually, listOrders, register, resetState, restingOrders, submit } from './harness';

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

describe('cancelling a filled order', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses it with 409 and keeps the order filled', async () => {
    const [seller, buyer] = [await register(app), await register(app)];
    const sell = await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' }).expect(202);
    await eventually(async () => expect((await listOrders(app, seller))[0]?.status).toBe('filled'));

    await cancel(app, seller, sell.body.orderId).expect(409);

    expect((await listOrders(app, seller))[0]).toMatchObject({ status: 'filled', remainingQuantity: '0.00000000' });
  });
});

describe('cancelling an order that is accepted but not applied yet', () => {
  let app: INestApplication;
  let redis: Redis;

  beforeEach(async () => {
    await resetState();
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    await redis.set(instrumentLockKey('ABC'), 'an-engine-that-froze', 'PX', 60_000);
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
    await redis.quit();
  });

  it('cancels it once it is applied, instead of answering 404 and letting it trade', async () => {
    const [seller, buyer] = [await register(app), await register(app)];
    const sell = await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    await cancel(app, seller, sell.body.orderId).expect(202);
    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' }).expect(202);
    await redis.del(instrumentLockKey('ABC'));

    await eventually(async () => expect((await listOrders(app, buyer))[0]?.status).toBe('open'), 10_000);
    expect((await listOrders(app, seller))[0]).toMatchObject({ status: 'cancelled', remainingQuantity: '1.00000000' });
    expect((await restingOrders(app)).asks).toEqual([]);
  });

  it("still answers 404 to anyone else cancelling it, and to an order that was never accepted", async () => {
    const [owner, other] = [await register(app), await register(app)];
    const sell = await submit(app, owner, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    await cancel(app, other, sell.body.orderId).expect(404);
    await cancel(app, owner, '6f0c7a52-3a8e-4c55-9d64-2f6f2d1f9b10').expect(404);
  });
});
