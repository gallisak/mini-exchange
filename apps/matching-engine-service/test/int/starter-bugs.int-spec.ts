import { INestApplication } from '@nestjs/common';
import {
  OrderRow,
  TestUser,
  book,
  cancel,
  createApp,
  eventually,
  listOrders,
  range,
  register,
  resetState,
  submit,
} from './harness';

const accepted = [201, 202];

describe('starter order handling bugs', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('keeps every order when many arrive at the same time', async () => {
    const users = await Promise.all(range(10).map(() => register(app)));

    const responses = await Promise.all(
      users.map((user, i) =>
        submit(app, user, { side: 'buy', price: `${90 + i}.00`, quantity: '1' }),
      ),
    );

    responses.forEach((response) => expect(accepted).toContain(response.status));
    await eventually(async () => {
      expect((await book(app, users[0])).bids).toHaveLength(10);
    });
  });

  it('never sells more than a resting order holds when buyers race for it', async () => {
    const [seller, ...buyers] = await Promise.all(range(11).map(() => register(app)));
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' });
    await eventually(async () => expect((await book(app, seller)).asks).toHaveLength(1));

    await Promise.all(
      buyers.map((buyer) => submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' })),
    );

    await eventually(async () => {
      const orders = (await Promise.all(buyers.map((buyer) => listOrders(app, buyer)))).flat();
      expect(orders).toHaveLength(10);
      expect(orders.filter((order) => order.status === 'filled')).toHaveLength(1);
      expect((await book(app, seller)).bids).toHaveLength(9);
    });
  });

  it('does not bring a cancelled order back into the book', async () => {
    const [seller, buyer] = await Promise.all(range(2).map(() => register(app)));
    for (const i of range(15)) {
      await submit(app, seller, { side: 'sell', price: `${200 + i}.00`, quantity: '1' });
    }
    await eventually(async () => expect((await book(app, seller)).asks).toHaveLength(15));
    const sells = await listOrders(app, seller);

    await Promise.all(
      sells.flatMap((order, i) => [
        cancel(app, seller, order.id, '?instrument=ABC'),
        submit(app, buyer, { side: 'buy', price: `${i + 1}.00`, quantity: '1' }),
      ]),
    );

    await eventually(async () => {
      const current = await book(app, seller);
      expect(current.asks).toHaveLength(0);
      expect(current.bids).toHaveLength(15);
    });
  });

  it('does not leave an order matchable when its cancel names another instrument', async () => {
    const [seller, buyer] = await Promise.all(range(2).map(() => register(app)));
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' });
    let sell: OrderRow | undefined;
    await eventually(async () => {
      [sell] = await listOrders(app, seller);
      expect(sell).toBeDefined();
    });

    const cancelResponse = await cancel(app, seller, sell!.id, '?instrument=DEF');
    expect([200, 202]).toContain(cancelResponse.status);
    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' });

    await eventually(async () => {
      const [buy] = await listOrders(app, buyer);
      expect(buy).toBeDefined();
      expect((await listOrders(app, seller))[0].status).toBe('cancelled');
      expect(buy.status).toBe('open');
    });
  });

  it("does not let a user cancel someone else's order", async () => {
    const [owner, intruder] = await Promise.all(range(2).map(() => register(app)));
    await submit(app, owner, { side: 'sell', price: '100.00', quantity: '1' });
    let order: OrderRow | undefined;
    await eventually(async () => {
      [order] = await listOrders(app, owner);
      expect(order).toBeDefined();
    });

    const response = await cancel(app, intruder, order!.id, '?instrument=ABC');
    await submit(app, owner, { side: 'buy', price: '1.00', quantity: '1' });

    expect(response.status).toBe(404);
    await eventually(async () => {
      const own = await listOrders(app, owner);
      expect(own.some((row) => row.price === '1.00')).toBe(true);
      expect(own.find((row) => row.id === order!.id)?.status).toBe('open');
    });
    expect((await book(app, owner)).asks).toHaveLength(1);
  });

  it('marks a resting order filled in the database once it trades', async () => {
    const [seller, buyer] = await Promise.all(range(2).map(() => register(app)));
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' });
    await eventually(async () => expect((await book(app, seller)).asks).toHaveLength(1));

    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' });

    await eventually(async () => {
      const [sell] = await listOrders(app, seller);
      expect(sell.status).toBe('filled');
      expect(Number(sell.remainingQuantity)).toBe(0);
    });
  });

  it('keeps resting orders after a restart', async () => {
    const seller: TestUser = await register(app);
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' });
    await eventually(async () => expect((await book(app, seller)).asks).toHaveLength(1));

    await app.close();
    app = await createApp();

    await eventually(async () => expect((await book(app, seller)).asks).toHaveLength(1));
  });

  it('creates one order when a request is retried with the same Idempotency-Key', async () => {
    const user = await register(app);
    const body = { side: 'buy' as const, price: '100.00', quantity: '1' };

    await submit(app, user, body, 'retry-key');
    await submit(app, user, body, 'retry-key');
    await submit(app, user, { side: 'buy', price: '1.00', quantity: '1' });

    await eventually(async () => {
      const orders = await listOrders(app, user);
      expect(orders.some((order) => order.price === '1.00')).toBe(true);
      expect(orders).toHaveLength(2);
    });
  });
});
