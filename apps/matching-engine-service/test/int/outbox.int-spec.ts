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
  });
});
