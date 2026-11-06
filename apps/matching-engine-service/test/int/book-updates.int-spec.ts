import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { BookRunner, BookRunnerOptions } from '../../src/orders/engine/book-runner';
import { commandStreamKey, encodeCommand } from '../../src/orders/engine/order-command';
import { InstrumentState } from '../../src/orders/entities/instrument-state.entity';
import { Order, OrderSide } from '../../src/orders/entities/order.entity';
import { TradeRecord } from '../../src/orders/entities/trade-record.entity';
import { OrderBookService } from '../../src/orders/order-book.service';
import { MarketEvent } from '../../src/orders/realtime/market-events';
import { RedisService } from '../../src/redis/redis.service';
import { uuidV5 } from '../../src/common/uuid';
import { eventually, resetState } from './harness';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a running book', () => {
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

  const options = (overrides: Partial<BookRunnerOptions> = {}): BookRunnerOptions => ({
    dataSource,
    redis,
    orderBook: new OrderBookService(),
    batchSize: 100,
    blockMs: 200,
    retryDelayMs: 100,
    fence: 1n,
    leaseValid: () => true,
    onFenced: () => undefined,
    ...overrides,
  });

  async function place(orderId: string, ownerId: string, side: OrderSide, quantity = '1') {
    await raw.xadd(
      commandStreamKey('ABC'),
      '*',
      ...encodeCommand({ type: 'submit', orderId, ownerId, side, price: '10.00', quantity }),
    );
  }

  it('fills one order against thousands of resting orders', async () => {
    const seller = randomUUID();
    const resting: Order[] = Array.from({ length: 7000 }, (_, i) => ({
      id: uuidV5(`resting:${i}`),
      ownerId: seller,
      instrument: 'ABC',
      side: 'sell',
      price: '10.00',
      quantity: '0.00000001',
      remainingQuantity: '0.00000001',
      status: 'open',
      createdAt: new Date(1_700_000_000_000 + i),
      seq: String(i + 1),
    }));
    for (let i = 0; i < resting.length; i += 1000) {
      await dataSource.getRepository(Order).insert(resting.slice(i, i + 1000));
    }
    await dataSource.getRepository(InstrumentState).insert({ instrument: 'ABC', orderSeq: '7000' });
    runner = new BookRunner('ABC', options());
    await runner.start();
    const buyId = uuidV5('large-buy');

    await place(buyId, randomUUID(), 'buy', '0.00007');

    await eventually(async () => {
      const buy = await dataSource.getRepository(Order).findOneBy({ id: buyId });
      expect(buy?.status).toBe('filled');
    }, 20000);
    expect(await dataSource.getRepository(TradeRecord).count()).toBe(7000);
  }, 60000);

  it('publishes the updates of a committed batch before it stops', async () => {
    const published: string[] = [];
    runner = new BookRunner(
      'ABC',
      options({
        publish: async (event) => {
          await sleep(300);
          published.push(event.type);
        },
      }),
    );
    await runner.start();
    await place(uuidV5('sell'), 'seller', 'sell');
    await place(uuidV5('buy'), 'buyer', 'buy');
    await eventually(async () =>
      expect(await dataSource.getRepository(TradeRecord).count()).toBe(1),
    );

    await runner.stop();
    runner = undefined;

    expect(published).toEqual(expect.arrayContaining(['trades', 'orders', 'book_delta']));
  });

  it('tells every client to reload when it takes a book over whose last changes were never published', async () => {
    await dataSource.getRepository(InstrumentState).insert({ instrument: 'ABC', bookSeq: '3' });
    const events: MarketEvent[] = [];
    runner = new BookRunner('ABC', options({ fence: 2n, publish: async (event) => void events.push(event) }));

    await runner.start();

    await eventually(async () =>
      expect(events).toContainEqual({
        type: 'resync',
        resync: { instruments: ['ABC'], owners: [], allOwners: true },
      }),
    );
  });

  it('stops at once even after its stream reader reconnected', async () => {
    runner = new BookRunner('ABC', options({ blockMs: 5000 }));
    await runner.start();
    const readers = async () =>
      ((await raw.client('LIST')) as string).split('\n').filter((line) => line.includes('cmd=xread'));
    await eventually(async () => expect(await readers()).toHaveLength(1));
    const [first] = await readers();
    const id = /\bid=(\d+)/.exec(first)?.[1] as string;
    await raw.client('KILL', 'ID', id);
    await eventually(async () => {
      const now = await readers();
      expect(now).toHaveLength(1);
      expect(/\bid=(\d+)/.exec(now[0])?.[1]).not.toBe(id);
    });

    const startedAt = Date.now();
    await runner.stop();
    runner = undefined;

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('does not make clients reload when the previous owner published everything it committed', async () => {
    runner = new BookRunner('ABC', options({ publish: async () => undefined }));
    await runner.start();
    await place(uuidV5('published'), 'seller', 'sell');
    await eventually(async () =>
      expect(
        (await dataSource.getRepository(InstrumentState).findOneByOrFail({ instrument: 'ABC' })).bookSeq,
      ).toBe('1'),
    );
    await runner.stop();
    const events: MarketEvent[] = [];

    runner = new BookRunner('ABC', options({ fence: 2n, publish: async (event) => void events.push(event) }));
    await runner.start();
    await sleep(500);

    expect(events.filter((event) => event.type === 'resync')).toEqual([]);
  });

  it('tells every client to reload after a batch whose commit may have gone through', async () => {
    const events: MarketEvent[] = [];
    const transaction = dataSource.transaction.bind(dataSource) as (...args: unknown[]) => Promise<unknown>;
    let failedAt: number | undefined;
    jest.spyOn(dataSource, 'transaction').mockImplementation((async (...args: unknown[]) => {
      const result = await transaction(...args);
      if (failedAt === undefined) {
        failedAt = events.length;
        throw new Error('Connection terminated unexpectedly');
      }
      return result;
    }) as never);
    runner = new BookRunner('ABC', options({ publish: async (event) => void events.push(event) }));
    await runner.start();

    await place(uuidV5('ambiguous'), 'seller', 'sell');

    await eventually(async () =>
      expect(events.slice(failedAt ?? events.length)).toContainEqual({
        type: 'resync',
        resync: { instruments: ['ABC'], owners: [], allOwners: true },
      }),
    );
  });

  it('keeps matching when Redis does not answer the note of what it published', async () => {
    const set = redis.client.set.bind(redis.client) as (...args: unknown[]) => Promise<unknown>;
    jest.spyOn(redis.client, 'set').mockImplementation(((...args: unknown[]) =>
      String(args[0]).startsWith('book:published:')
        ? new Promise(() => undefined)
        : set(...args)) as never);
    runner = new BookRunner('ABC', options({ publish: async () => undefined }));
    await runner.start();
    const bookSeq = async () =>
      (await dataSource.getRepository(InstrumentState).findOneByOrFail({ instrument: 'ABC' })).bookSeq;

    await place(uuidV5('first'), 'seller', 'sell');
    await eventually(async () => expect(await bookSeq()).toBe('1'));
    await place(uuidV5('second'), 'seller', 'sell');

    await eventually(async () => expect(await bookSeq()).toBe('2'), 5000);
  });

  it('does not note a batch as published when its updates could not be published', async () => {
    runner = new BookRunner(
      'ABC',
      options({
        publish: (async (event: MarketEvent) => event.type !== 'book_delta' && event.type !== 'resync') as never,
      }),
    );
    await runner.start();

    await place(uuidV5('unpublished'), 'seller', 'sell');
    await eventually(async () =>
      expect(
        (await dataSource.getRepository(InstrumentState).findOneByOrFail({ instrument: 'ABC' })).bookSeq,
      ).toBe('1'),
    );
    await sleep(300);

    expect(await raw.get('book:published:ABC')).toBeNull();
  });

  it('does not note a later batch as published while an earlier one was lost, until the publisher told clients to reload', async () => {
    let losses = 1;
    let resyncPending = true;
    runner = new BookRunner(
      'ABC',
      options({
        publish: (async (event: MarketEvent) => {
          if (event.type === 'book_delta' && losses > 0) {
            losses -= 1;
            return false;
          }
          return true;
        }) as never,
        resyncPending: () => resyncPending,
      }),
    );
    await runner.start();
    const bookSeq = async () =>
      (await dataSource.getRepository(InstrumentState).findOneByOrFail({ instrument: 'ABC' })).bookSeq;

    await place(uuidV5('lost'), 'seller', 'sell');
    await eventually(async () => expect(await bookSeq()).toBe('1'));
    await place(uuidV5('later'), 'seller', 'sell');
    await eventually(async () => expect(await bookSeq()).toBe('2'));
    await sleep(300);
    const whileLost = await raw.get('book:published:ABC');
    resyncPending = false;
    await place(uuidV5('after the resync'), 'seller', 'sell');
    await eventually(async () => expect(await bookSeq()).toBe('3'));
    await sleep(300);

    expect(whileLost).toBeNull();
    expect(await raw.get('book:published:ABC')).toBe('3');
  });

  it('does not note a book it took over as published when it could not tell clients to reload', async () => {
    await dataSource.getRepository(InstrumentState).insert({ instrument: 'ABC', bookSeq: '3' });
    runner = new BookRunner(
      'ABC',
      options({ fence: 2n, publish: (async (event: MarketEvent) => event.type !== 'resync') as never }),
    );
    await runner.start();

    await place(uuidV5('after the takeover'), 'seller', 'sell');
    await eventually(async () =>
      expect(
        (await dataSource.getRepository(InstrumentState).findOneByOrFail({ instrument: 'ABC' })).bookSeq,
      ).toBe('4'),
    );
    await sleep(300);

    expect(await raw.get('book:published:ABC')).toBeNull();
  });
});
