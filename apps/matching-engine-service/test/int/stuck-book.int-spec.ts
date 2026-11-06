import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { BookRunner, stuckKey } from '../../src/orders/engine/book-runner';
import { commandStreamKey, encodeCommand } from '../../src/orders/engine/order-command';
import { TradeRecord } from '../../src/orders/entities/trade-record.entity';
import { OrderBookService } from '../../src/orders/order-book.service';
import { RedisService } from '../../src/redis/redis.service';
import { uuidV5 } from '../../src/common/uuid';
import { eventually, resetState } from './harness';

describe('a book whose batch keeps failing', () => {
  let dataSource: DataSource;
  let redis: RedisService;
  let raw: Redis;
  let runner: BookRunner | undefined;

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    redis = new RedisService();
    raw = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  });

  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    await raw.quit();
    await redis.onApplicationShutdown();
    await dataSource.destroy();
  });

  async function place(name: string, ownerId: string, side: 'buy' | 'sell') {
    await raw.xadd(
      commandStreamKey('ABC'),
      '*',
      ...encodeCommand({ type: 'submit', orderId: uuidV5(name), ownerId, side, price: '10.00', quantity: '1' }),
    );
  }

  it('is reported as stuck while it cannot commit and cleared once it can', async () => {
    const blocker = randomUUID();
    await dataSource.getRepository(TradeRecord).insert({
      id: blocker,
      instrument: 'ABC',
      seq: '1',
      buyOrderId: randomUUID(),
      sellOrderId: randomUUID(),
      buyerId: 'x',
      sellerId: 'y',
      price: '1.00',
      quantity: '1',
      executedAt: new Date(),
    });
    runner = new BookRunner('ABC', {
      dataSource,
      redis,
      orderBook: new OrderBookService(),
      batchSize: 100,
      blockMs: 200,
      retryDelayMs: 100,
      fence: 1n,
      leaseValid: () => true,
      onFenced: () => undefined,
    });
    await runner.start();

    await place('sell-1', 'seller', 'sell');
    await place('buy-1', 'buyer', 'buy');

    await eventually(async () => {
      const stuck = JSON.parse((await raw.get(stuckKey('ABC'))) ?? 'null');
      expect(stuck).toEqual({
        since: expect.any(String),
        failures: expect.any(Number),
        error: expect.stringMatching(/duplicate key/),
      });
      expect(stuck.failures).toBeGreaterThanOrEqual(2);
    });

    await dataSource.getRepository(TradeRecord).delete({ id: blocker });

    await eventually(async () => {
      expect(await raw.get(stuckKey('ABC'))).toBeNull();
      expect(await dataSource.getRepository(TradeRecord).count()).toBe(1);
    });
  });

  it('keeps retrying and recovers while Redis does not answer the note that it is stuck', async () => {
    const blocker = randomUUID();
    await dataSource.getRepository(TradeRecord).insert({
      id: blocker,
      instrument: 'ABC',
      seq: '1',
      buyOrderId: randomUUID(),
      sellOrderId: randomUUID(),
      buyerId: 'x',
      sellerId: 'y',
      price: '1.00',
      quantity: '1',
      executedAt: new Date(),
    });
    const set = redis.client.set.bind(redis.client) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(redis.client, 'set').mockImplementation(((...args: unknown[]) =>
      String(args[0]).startsWith('book:stuck:') ? new Promise(() => undefined) : set(...args)) as never);
    runner = new BookRunner('ABC', {
      dataSource,
      redis,
      orderBook: new OrderBookService(),
      batchSize: 100,
      blockMs: 200,
      retryDelayMs: 100,
      fence: 1n,
      leaseValid: () => true,
      onFenced: () => undefined,
    });
    await runner.start();

    await place('sell-1', 'seller', 'sell');
    await place('buy-1', 'buyer', 'buy');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await dataSource.getRepository(TradeRecord).delete({ id: blocker });

    await eventually(async () => expect(await dataSource.getRepository(TradeRecord).count()).toBe(1), 10_000);
  });
});
