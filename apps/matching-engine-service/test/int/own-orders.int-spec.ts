import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

  it('pages through older finished orders, oldest last, and only those of the user', async () => {
    const [trader, other] = [await register(app), await register(app)];
    for (const i of range(5)) {
      await submit(app, other, { side: 'buy', price: '50.00', quantity: '1' }).expect(202);
      await submit(app, trader, { side: 'sell', price: '50.00', quantity: '1' }).expect(202);
      await eventually(async () =>
        expect(await app.get(DataSource).query('SELECT id FROM trades')).toHaveLength(i + 1),
      );
    }
    const history = (before: { id: string; createdAt: string }) =>
      request(app.getHttpServer())
        .get('/orders/history')
        .query({ before: before.createdAt, beforeId: before.id })
        .set('authorization', `Bearer ${trader.token}`)
        .expect(200)
        .then((response) => response.body as { id: string; createdAt: string; ownerId: string }[]);

    const first = (await listOrders(app, trader)) as unknown as { id: string; createdAt: string; ownerId: string }[];
    const second = await history(first[first.length - 1]);
    const third = await history(second[second.length - 1]);
    const last = await history(third[third.length - 1]);

    const ids = [...first, ...second, ...third].map((order) => order.id);
    expect([first.length, second.length, third.length, last.length]).toEqual([2, 2, 1, 0]);
    expect(new Set(ids).size).toBe(5);
    expect([...second, ...third].every((order) => order.ownerId === trader.userId)).toBe(true);
  });

  it('refuses a page that does not name the oldest order shown', async () => {
    const trader = await register(app);

    await request(app.getHttpServer())
      .get('/orders/history')
      .query({ before: 'yesterday', beforeId: 'nope' })
      .set('authorization', `Bearer ${trader.token}`)
      .expect(400);
  });
});
