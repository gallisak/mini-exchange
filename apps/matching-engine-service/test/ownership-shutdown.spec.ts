import { DataSource } from 'typeorm';
import { InstrumentOwnershipService } from '../src/orders/engine/instrument-ownership.service';
import { RedisLockService } from '../src/locks/redis-lock.service';
import { MatchingEngineService } from '../src/orders/engine/matching-engine.service';
import { RedisService } from '../src/redis/redis.service';
import { OrderBookService } from '../src/orders/order-book.service';
import { MarketPublisherService } from '../src/orders/realtime/market-publisher.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('shutting down an owner', () => {
  it('keeps the lease valid until its book has stopped, then releases it', async () => {
    const events: string[] = [];
    const lock = {
      acquire: async () => null,
      renew: async () => true,
      release: async () => {
        events.push('released');
        return true;
      },
      raiseFence: async () => undefined,
    } as unknown as RedisLockService;
    const engine = new MatchingEngineService(
      {} as DataSource,
      {} as RedisService,
      {} as OrderBookService,
      {} as MarketPublisherService,
    );
    const ownership = new InstrumentOwnershipService(lock, engine);
    const internals = ownership as unknown as {
      owned: Map<string, { token: bigint; renewedAt: number }>;
      isLeaseValid: (instrument: string, token: bigint) => boolean;
    };
    internals.owned.set('ABC', { token: 1n, renewedAt: performance.now() });
    (engine as unknown as { runners: Map<string, unknown> }).runners.set('ABC', {
      fence: 1n,
      stop: async () => {
        await sleep(100);
        events.push(`book stopped, lease valid: ${internals.isLeaseValid('ABC', 1n)}`);
      },
    });

    await Promise.all([engine.onModuleDestroy(), ownership.onModuleDestroy()]);

    expect(events).toEqual(['book stopped, lease valid: true', 'released']);
  });

  it('does not take an instrument while its previous book is still stopping', async () => {
    const acquired: string[] = [];
    const lock = {
      acquire: async (key: string) => {
        acquired.push(key);
        return null;
      },
      renew: async () => true,
      release: async () => true,
      raiseFence: async () => undefined,
    } as unknown as RedisLockService;
    const engine = {
      isStopping: (instrument: string) => instrument === 'ABC',
      startInstrument: async () => undefined,
      stopInstrument: async () => undefined,
    } as unknown as MatchingEngineService;
    const ownership = new InstrumentOwnershipService(lock, engine);

    await (ownership as unknown as { acquireFree: () => Promise<void> }).acquireFree();

    expect(acquired).toEqual(['lock:instrument:DEF', 'lock:instrument:XYZ']);
  });
});
