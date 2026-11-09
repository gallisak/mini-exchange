import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { OutboxMessage } from '../../src/outbox/outbox-message.entity';
import { OutboxRelayService } from '../../src/outbox/outbox-relay.service';
import { tradeStreamKey } from '../../src/outbox/trade-event';
import { RedisService } from '../../src/redis/redis.service';
import { createApp, eventually, range, register, resetState, submit } from './harness';

type StreamEntry = [id: string, fields: string[]];

async function tradeEvents(instrument = 'ABC') {
  const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  const entries = (await redis.xrange(tradeStreamKey(instrument), '-', '+')) as StreamEntry[];
  await redis.quit();
  return entries.map(([, fields]) => ({ type: fields[1], payload: JSON.parse(fields[3]) }));
}

describe('trade events outbox', () => {
  describe('through the engine', () => {
    let app: INestApplication;

    beforeEach(async () => {
      await resetState();
      app = await createApp();
    });

    afterEach(async () => {
      await app.close();
    });

    it('publishes every trade once with both counterparties', async () => {
      const seller = await register(app);
      const buyer = await register(app);

      await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
      await submit(app, seller, { side: 'sell', price: '101.00', quantity: '1' }).expect(202);
      await submit(app, buyer, { side: 'buy', price: '101.00', quantity: '2' }).expect(202);

      await eventually(async () => expect(await tradeEvents()).toHaveLength(2));
      const events = await tradeEvents();
      expect(events.map((event) => event.type)).toEqual(['trade.executed', 'trade.executed']);
      expect(events.map((event) => event.payload)).toEqual([
        expect.objectContaining({
          instrument: 'ABC',
          seq: '1',
          buyerId: buyer.userId,
          sellerId: seller.userId,
          price: '100.00',
          quantity: '1.00000000',
        }),
        expect.objectContaining({ seq: '2', price: '101.00' }),
      ]);
      const dataSource = app.get(DataSource);
      const trades = await dataSource.query(`SELECT id FROM trades ORDER BY seq`);
      expect(events.map((event) => event.payload.tradeId)).toEqual(
        trades.map((trade: { id: string }) => trade.id),
      );
      await eventually(async () => {
        expect(
          await dataSource.query(`SELECT 1 FROM outbox WHERE "publishedAt" IS NULL`),
        ).toHaveLength(0);
      });
    });
  });

  describe('relay', () => {
    let dataSource: DataSource;
    const redisServices: RedisService[] = [];

    beforeEach(async () => {
      await resetState();
      dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    });

    afterEach(async () => {
      await Promise.all(redisServices.splice(0).map((redis) => redis.onApplicationShutdown()));
      await dataSource.destroy();
    });

    function relay() {
      const redis = new RedisService();
      redisServices.push(redis);
      return new OutboxRelayService(dataSource, redis);
    }

    it('publishes each message once when two instances relay at the same time', async () => {
      await dataSource.getRepository(OutboxMessage).insert(
        range(50).map((i) => ({
          stream: tradeStreamKey('ABC'),
          type: 'trade.executed',
          payload: { n: i },
        })),
      );
      const relays = [relay(), relay()];

      for (;;) {
        const published = await Promise.all(relays.map((instance) => instance.publishPending()));
        if (published.every((count) => count === 0)) break;
      }

      const events = await tradeEvents();
      expect(events.map((event) => event.payload.n)).toEqual(range(50));
    });

    it('purges published messages after the retention period and keeps the rest', async () => {
      const outbox = dataSource.getRepository(OutboxMessage);
      const message = { stream: tradeStreamKey('ABC'), type: 'trade.executed', payload: {} };
      await outbox.insert([
        { ...message, publishedAt: new Date(Date.now() - 2 * 3_600_000) },
        { ...message, publishedAt: new Date() },
        { ...message, publishedAt: null },
      ]);

      expect(await relay().purgePublished(3_600_000)).toBe(1);
      expect(await outbox.count()).toBe(2);
    });

    it('purges a backlog a batch at a time and keeps relaying until it is gone', async () => {
      process.env.OUTBOX_PURGE_BATCH = '3';
      const outbox = dataSource.getRepository(OutboxMessage);
      const old = {
        stream: tradeStreamKey('ABC'),
        type: 'trade.executed',
        payload: {},
        publishedAt: new Date(Date.now() - 2 * 3_600_000),
      };
      await outbox.insert(range(7).map(() => old));
      const instance = relay();
      delete process.env.OUTBOX_PURGE_BATCH;

      expect(await instance.purgePublished(3_600_000)).toBe(3);
      expect(await outbox.count()).toBe(4);

      process.env.OUTBOX_RETENTION_HOURS = '1';
      const purging = relay();
      delete process.env.OUTBOX_RETENTION_HOURS;
      purging.onApplicationBootstrap();
      await eventually(async () => expect(await outbox.count()).toBe(0));
      await purging.onModuleDestroy();
    });

    it('does not make publishing wait for a purge', async () => {
      const instance = relay();
      let finishPurge!: () => void;
      const purge = jest.spyOn(instance, 'purgePublished').mockImplementation(
        () => new Promise<number>((resolve) => (finishPurge = () => resolve(0))),
      );
      const outbox = dataSource.getRepository(OutboxMessage);
      await outbox.insert({ stream: tradeStreamKey('ABC'), type: 'trade.executed', payload: {} });

      instance.onApplicationBootstrap();
      await eventually(async () => expect(await tradeEvents()).toHaveLength(1));
      await eventually(async () => expect(purge).toHaveBeenCalledTimes(1));
      await outbox.insert({ stream: tradeStreamKey('ABC'), type: 'trade.executed', payload: {} });
      await eventually(async () => expect(await tradeEvents()).toHaveLength(2));

      expect(purge).toHaveBeenCalledTimes(1);
      finishPurge();
      await instance.onModuleDestroy();
    });

    it('does not purge again at once while a backlog is left, so a long backlog does not take over the database', async () => {
      process.env.OUTBOX_PURGE_BATCH = '1';
      const instance = relay();
      delete process.env.OUTBOX_PURGE_BATCH;
      const purge = jest.spyOn(instance, 'purgePublished').mockResolvedValue(1);

      instance.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await instance.onModuleDestroy();

      expect(purge).toHaveBeenCalledTimes(1);
    });
  });
});

describe('trade events outbox while Redis does not answer', () => {
  let dataSource: DataSource;
  let redis: RedisService;

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    redis = new RedisService();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await redis.onApplicationShutdown();
    await dataSource.destroy();
  });

  it('gives up on a publish Redis never answers instead of holding the relay forever', async () => {
    const relay = new OutboxRelayService(dataSource, redis);
    await dataSource.getRepository(OutboxMessage).insert({
      stream: tradeStreamKey('ABC'),
      type: 'trade.executed',
      payload: { tradeId: 'hanging' },
    });
    const multi = redis.client.multi.bind(redis.client);
    jest.spyOn(redis.client, 'multi').mockImplementationOnce(((...args: unknown[]) => {
      const batch = (multi as (...a: unknown[]) => ReturnType<typeof multi>)(...args);
      batch.exec = (() => new Promise(() => undefined)) as never;
      return batch;
    }) as never);

    const first = await Promise.race([
      relay.publishPending().then(
        () => 'published',
        () => 'failed',
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 10_000)),
    ]);

    expect(first).toBe('failed');
    expect(await relay.publishPending()).toBe(1);
  });
});
