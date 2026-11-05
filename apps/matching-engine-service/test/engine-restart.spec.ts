import { DataSource } from 'typeorm';
import { MatchingEngineService } from '../src/orders/engine/matching-engine.service';
import { RedisService } from '../src/redis/redis.service';
import { OrderBookService } from '../src/orders/order-book.service';
import { MarketPublisherService } from '../src/orders/realtime/market-publisher.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('starting a book again', () => {
  it('waits until the previous book of the instrument has stopped', async () => {
    const events: string[] = [];
    const dataSource = {
      createQueryBuilder: () => {
        events.push('new book started');
        throw new Error('stop the test here');
      },
    } as unknown as DataSource;
    const engine = new MatchingEngineService(
      dataSource,
      {} as RedisService,
      {} as OrderBookService,
      {} as MarketPublisherService,
    );
    (engine as unknown as { runners: Map<string, unknown> }).runners.set('ABC', {
      fence: 1n,
      stop: async () => {
        await sleep(100);
        events.push('old book stopped');
      },
    });

    const stopping = engine.stopInstrument('ABC');
    const starting = engine
      .startInstrument('ABC', { fence: 2n, isValid: () => true, onFenced: () => undefined })
      .catch(() => undefined);
    await Promise.all([stopping, starting]);

    expect(events).toEqual(['old book stopped', 'new book started']);
  });
});
