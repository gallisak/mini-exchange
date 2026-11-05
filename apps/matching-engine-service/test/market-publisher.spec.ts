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
});
