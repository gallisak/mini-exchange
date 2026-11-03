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
});
