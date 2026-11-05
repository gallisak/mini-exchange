import { MarketPublisherService } from '../src/orders/realtime/market-publisher.service';
import { MarketEvent } from '../src/orders/realtime/market-events';
import { RedisService } from '../src/redis/redis.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('publishing market events', () => {
  let publisher: MarketPublisherService | undefined;

  afterEach(() => {
    (publisher as unknown as { onModuleDestroy?: () => void } | undefined)?.onModuleDestroy?.();
  });

  it('tells the owners of a lost order update to reload even if nothing else is published', async () => {
    const published: string[] = [];
    let failing = true;
    const redis = {
      client: {
        publish: async (_channel: string, message: string) => {
          if (failing) {
            failing = false;
            throw new Error('Connection is closed.');
          }
          published.push(message);
          return 1;
        },
      },
    } as unknown as RedisService;
    publisher = new MarketPublisherService(redis);
    const lost = {
      type: 'orders',
      orders: [{ id: 'order-1', ownerId: 'owner-1', instrument: 'ABC' }],
    } as unknown as MarketEvent;

    await publisher.publish('ABC', lost);
    await sleep(1500);

    expect(published.map((message) => JSON.parse(message))).toEqual([
      { type: 'resync', resync: { instruments: [], owners: ['owner-1'] } },
    ]);
  });

  const delta = {
    type: 'book_delta',
    delta: { instrument: 'ABC', seq: 1, changes: [] },
  } as MarketEvent;

  it('gives up on a publish that never answers and tells its subscribers to reload', async () => {
    const published: string[] = [];
    let hanging = true;
    const redis = {
      client: {
        publish: (_channel: string, message: string) => {
          if (hanging) {
            hanging = false;
            return new Promise(() => undefined);
          }
          published.push(message);
          return Promise.resolve(1);
        },
      },
    } as unknown as RedisService;
    publisher = new MarketPublisherService(redis);
    const startedAt = Date.now();

    await publisher.publish('ABC', delta);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await sleep(1_500);
    expect(published.map((message) => JSON.parse(message))).toEqual([
      { type: 'resync', resync: { instruments: ['ABC'], owners: [] } },
    ]);
  }, 10_000);

  it('leaves no timer behind once it was shut down', async () => {
    jest.useFakeTimers();
    try {
      const redis = {
        client: {
          publish: async () => {
            throw new Error('Connection is closed.');
          },
        },
      } as unknown as RedisService;
      publisher = new MarketPublisherService(redis);
      publisher.onModuleDestroy();

      await publisher.publish('ABC', delta);

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
