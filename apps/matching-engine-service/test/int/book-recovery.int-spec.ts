import Redis from 'ioredis';
import { DataSource, EntityManager } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { BookRunner } from '../../src/orders/engine/book-runner';
import { commandStreamKey, encodeCommand } from '../../src/orders/engine/order-command';
import { InstrumentState } from '../../src/orders/entities/instrument-state.entity';
import { Order } from '../../src/orders/entities/order.entity';
import { TradeRecord } from '../../src/orders/entities/trade-record.entity';
import { OrderBookService } from '../../src/orders/order-book.service';
import { RedisService } from '../../src/redis/redis.service';
import { uuidV5 } from '../../src/common/uuid';
import { eventually, resetState } from './harness';

describe('a book whose commit was answered with an error', () => {
  let dataSource: DataSource;
  let redis: RedisService;
  let raw: Redis;
  let runner: BookRunner | undefined;
  let commitsLost = 0;
  let loadsFailing = 0;

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    redis = new RedisService();
    raw = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    commitsLost = 0;
    loadsFailing = 0;
  });

  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    await raw.quit();
    await redis.onApplicationShutdown();
    await dataSource.destroy();
  });

  const lost = () => new Error('Connection terminated unexpectedly');

  function flaky(target: DataSource): DataSource {
    return new Proxy(target, {
      get(source, property, receiver) {
        if (property === 'transaction') {
          return async (work: (manager: EntityManager) => Promise<unknown>) => {
            const result = await source.transaction(work);
            if (commitsLost > 0) {
              commitsLost -= 1;
              throw lost();
            }
            return result;
          };
        }
        if (property === 'getRepository') {
          return (entity: unknown) => {
            if (entity === InstrumentState && loadsFailing > 0) {
              loadsFailing -= 1;
              return {
                findOneByOrFail: async () => {
                  throw lost();
                },
              };
            }
            return source.getRepository(entity as typeof Order);
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === 'function' ? value.bind(source) : value;
      },
    });
  }

  async function place(name: string, ownerId: string, side: 'buy' | 'sell') {
    const orderId = uuidV5(name);
    await raw.xadd(
      commandStreamKey('ABC'),
      '*',
      ...encodeCommand({ type: 'submit', orderId, ownerId, side, price: '10.00', quantity: '1' }),
    );
    return orderId;
  }

  const stored = (orderId: string) => dataSource.getRepository(Order).findOneBy({ id: orderId });

  it('does not match against a book older than its last commit when reloading fails once', async () => {
    runner = new BookRunner('ABC', {
      dataSource: flaky(dataSource),
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

    const sell = await place('sell-1', 'seller', 'sell');
    await eventually(async () => expect(await stored(sell)).not.toBeNull());

    commitsLost = 1;
    loadsFailing = 1;
    await place('buy-1', 'buyer', 'buy');
    await eventually(async () => expect(await dataSource.getRepository(TradeRecord).count()).toBe(1));
    await eventually(async () => expect(loadsFailing).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const late = await place('buy-2', 'late-buyer', 'buy');
    await eventually(async () => expect((await stored(late))?.status).toBe('open'), 10000);

    const state = await dataSource.getRepository(InstrumentState).findOneByOrFail({ instrument: 'ABC' });
    const seqs = (await dataSource.getRepository(Order).find()).map((order) => order.seq);
    expect({ orderSeq: state.orderSeq, tradeSeq: state.tradeSeq }).toEqual({ orderSeq: '3', tradeSeq: '1' });
    expect(new Set(seqs).size).toBe(3);
    expect(await dataSource.getRepository(TradeRecord).count()).toBe(1);
    expect((await stored(sell))?.status).toBe('filled');
  });
});
