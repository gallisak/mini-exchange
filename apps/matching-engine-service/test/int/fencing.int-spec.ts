import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { BookRunner } from '../../src/orders/engine/book-runner';
import { FencedOutError } from '../../src/orders/engine/fenced-out.error';
import { commandStreamKey, encodeCommand } from '../../src/orders/engine/order-command';
import { Order } from '../../src/orders/entities/order.entity';
import { OrderBookService } from '../../src/orders/order-book.service';
import { RedisService } from '../../src/redis/redis.service';
import { uuidV5 } from '../../src/common/uuid';
import { eventually, resetState } from './harness';

describe('fencing of the order book writer', () => {
  let dataSource: DataSource;
  let redis: RedisService;
  const runners: BookRunner[] = [];

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    redis = new RedisService();
  });

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((runner) => runner.stop()));
    await dataSource.destroy();
    await redis.onApplicationShutdown();
  });

  function runner(fence: bigint, leaseValid: () => boolean = () => true) {
    const fenced: FencedOutError[] = [];
    const instance = new BookRunner('ABC', {
      dataSource,
      redis,
      orderBook: new OrderBookService(),
      batchSize: 100,
      blockMs: 200,
      retryDelayMs: 100,
      fence,
      leaseValid,
      onFenced: (error) => fenced.push(error),
    });
    runners.push(instance);
    return { instance, fenced };
  }

  async function submitCommand(name: string) {
    const orderId = uuidV5(name);
    const client = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    await client.xadd(
      commandStreamKey('ABC'),
      '*',
      ...encodeCommand({
        type: 'submit',
        orderId,
        ownerId: 'owner',
        side: 'buy',
        price: '10.00',
        quantity: '1.00000000',
      }),
    );
    await client.quit();
    return orderId;
  }

  const setFence = (fence: number) =>
    dataSource.query(`UPDATE instrument_state SET fence = $1 WHERE instrument = 'ABC'`, [fence]);
  const storedOrders = () => dataSource.getRepository(Order).count();

  it('commits a batch while it holds the current fence', async () => {
    const { instance } = runner(1n);
    await instance.start();

    const orderId = await submitCommand('order-1');

    await eventually(async () => {
      expect(await dataSource.getRepository(Order).findOneBy({ id: orderId })).not.toBeNull();
    });
  });

  it('commits nothing once a newer owner has claimed the fence, and reports it', async () => {
    const { instance, fenced } = runner(1n);
    await instance.start();
    await setFence(2);

    await submitCommand('order-1');

    await eventually(async () => expect(fenced).toHaveLength(1));
    expect(fenced[0].currentFence).toBe(2n);
    expect(await storedOrders()).toBe(0);
  });

  it('refuses to start below the current fence', async () => {
    const first = runner(5n);
    await first.instance.start();
    await first.instance.stop();

    await expect(runner(3n).instance.start()).rejects.toMatchObject({ currentFence: 5n });
  });

  it('stops committing once its lease has expired by its own clock', async () => {
    const { instance, fenced } = runner(1n, () => false);
    await instance.start();

    await submitCommand('order-1');

    await eventually(async () => expect(fenced).toHaveLength(1));
    expect(fenced[0].currentFence).toBeNull();
    expect(await storedOrders()).toBe(0);
  });

  it('stops announcing its sequence number once its lease has expired by its own clock', async () => {
    const announced: string[] = [];
    let valid = true;
    const instance = new BookRunner('ABC', {
      dataSource,
      redis,
      orderBook: new OrderBookService(),
      batchSize: 100,
      blockMs: 200,
      retryDelayMs: 100,
      fence: 1n,
      leaseValid: () => valid,
      onFenced: () => undefined,
      publish: async (event) => {
        announced.push(event.type);
      },
      heartbeatMs: 50,
    });
    runners.push(instance);
    await instance.start();
    await eventually(async () => expect(announced).toContain('book_heartbeat'));

    valid = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    announced.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(announced).toEqual([]);
  });

  it('leaves the book in memory alone once stopped, even when a reload it gave up waiting for answers later', async () => {
    const book = new OrderBookService();
    let failNext = false;
    let release!: () => void;
    let held: Promise<void> | null = null;
    let reloading = false;
    const slow = new Proxy(dataSource, {
      get(target, property, receiver) {
        if (property === 'transaction' && failNext) {
          return async () => {
            failNext = false;
            held = new Promise<void>((resolve) => (release = resolve));
            throw new Error('connection lost');
          };
        }
        if (property === 'getRepository') {
          return (entity: unknown) => {
            const repository = target.getRepository(entity as typeof Order);
            if (entity !== Order || !held) return repository;
            const wait = held;
            return new Proxy(repository, {
              get(inner, name, innerReceiver) {
                if (name !== 'find') return Reflect.get(inner, name, innerReceiver);
                return async (...args: Parameters<typeof inner.find>) => {
                  const rows = await inner.find(...args);
                  reloading = true;
                  await wait;
                  return rows;
                };
              },
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const options = {
      redis,
      orderBook: book,
      batchSize: 100,
      blockMs: 200,
      retryDelayMs: 100,
      leaseValid: () => true,
      onFenced: () => undefined,
      stopWaitMs: 50,
    };
    const old = new BookRunner('ABC', { ...options, dataSource: slow, fence: 1n });
    runners.push(old);
    await old.start();
    failNext = true;
    const orderId = await submitCommand('order-1');
    await eventually(async () => expect(reloading).toBe(true));
    await old.stop();

    const next = new BookRunner('ABC', { ...options, dataSource, fence: 2n });
    runners.push(next);
    await next.start();
    await eventually(async () => expect(book.findOrder('ABC', orderId)).toBeDefined());
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(book.findOrder('ABC', orderId)).toBeDefined();
  });
});
