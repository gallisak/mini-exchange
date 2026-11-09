import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { commandStreamKey } from '../../src/orders/engine/order-command';
import { RedisService } from '../../src/redis/redis.service';
import {
  createApp,
  eventually,
  listOrders,
  register,
  resetState,
  submit,
} from './harness';

function rawRedis() {
  return new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
}

const order = { side: 'sell' as const, price: '100.00', quantity: '1' };

describe('engine guards', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('replays a request with the same key and body under the same order id', async () => {
    const user = await register(app);

    const first = await submit(app, user, order, 'same-key');
    const retry = await submit(app, user, order, 'same-key');

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.body.orderId).toBe(first.body.orderId);
  });

  it('rejects a key reused with a different order', async () => {
    const user = await register(app);

    const first = await submit(app, user, order, 'key-1');
    const changed = await submit(app, user, { ...order, price: '101.00' }, 'key-1');

    expect(first.status).toBe(202);
    expect(changed.status).toBe(422);
  });

  it('rejects a key reused on another instrument instead of losing the order', async () => {
    const user = await register(app);

    const abc = await submit(app, user, { ...order, instrument: 'ABC' }, 'key-1');
    const def = await submit(app, user, { ...order, instrument: 'DEF' }, 'key-1');

    expect(abc.status).toBe(202);
    expect(def.status).toBe(422);
    await eventually(async () => {
      expect((await listOrders(app, user)).map((o) => o.instrument)).toEqual(['ABC']);
    });
  });

  it('still rejects a different order after the key record has expired', async () => {
    const user = await register(app);
    await submit(app, user, order, 'key-1');
    await eventually(async () => expect(await listOrders(app, user)).toHaveLength(1));
    const redis = rawRedis();
    await redis.del(...(await redis.keys('orders:idempotency:*')));
    await redis.quit();

    const changed = await submit(app, user, { ...order, quantity: '2' }, 'key-1');

    expect(changed.status).toBe(422);
  });

  it('keeps processing an instrument after a malformed command in its stream', async () => {
    const user = await register(app);
    const redis = rawRedis();
    await redis.xadd(
      commandStreamKey('ABC'),
      '*',
      'command',
      JSON.stringify({
        type: 'submit',
        orderId: 'not-a-uuid',
        ownerId: user.userId,
        side: 'buy',
        price: '1.00',
        quantity: '1',
      }),
    );
    await redis.quit();

    await submit(app, user, { side: 'buy', price: '5.00', quantity: '1' });

    await eventually(async () => {
      expect((await listOrders(app, user)).map((o) => o.price)).toEqual(['5.00']);
    });
  });

  it('answers 503 instead of hanging when Redis does not take the order, and keeps its key usable', async () => {
    const user = await register(app);
    const client = app.get(RedisService).client;
    const hanging = { set: () => hanging, xadd: () => hanging, exec: () => new Promise(() => undefined) };
    jest.spyOn(client, 'multi').mockImplementationOnce((() => hanging) as never);

    const lost = await submit(app, user, order, 'hanging-key');
    const retried = await submit(app, user, order, 'hanging-key');

    expect(lost.status).toBe(503);
    expect(retried.status).toBe(202);
    await eventually(async () => expect(await listOrders(app, user)).toHaveLength(1));
  });
});
