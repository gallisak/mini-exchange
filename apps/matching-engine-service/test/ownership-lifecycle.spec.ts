import { InstrumentOwnershipService } from '../src/orders/engine/instrument-ownership.service';
import { RedisLockService } from '../src/locks/redis-lock.service';
import {
  InstrumentLease,
  MatchingEngineService,
} from '../src/orders/engine/matching-engine.service';
import { FencedOutError } from '../src/orders/engine/fenced-out.error';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Setup {
  acquire: (key: string) => Promise<bigint | null>;
  startDelayMs: number;
}

function ownership({ acquire, startDelayMs }: Setup) {
  const calls = {
    renewed: [] as string[],
    started: [] as string[],
    stopped: [] as string[],
    released: [] as string[],
  };
  const lock = {
    acquire,
    renew: async (key: string) => {
      calls.renewed.push(key);
      return true;
    },
    release: async (key: string) => {
      calls.released.push(key);
      return true;
    },
    raiseFence: async () => undefined,
  } as unknown as RedisLockService;
  const engine = {
    startInstrument: async (instrument: string) => {
      await sleep(startDelayMs);
      calls.started.push(instrument);
    },
    stopInstrument: async (instrument: string) => {
      calls.stopped.push(instrument);
    },
  } as unknown as MatchingEngineService;
  return { service: new InstrumentOwnershipService(lock, engine), calls };
}

describe('instrument ownership lifecycle', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.LOCK_TTL_MS = '600';
    process.env.LOCK_RENEW_INTERVAL_MS = '100';
    process.env.LOCK_ACQUIRE_INTERVAL_MS = '50';
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('keeps renewing leases while slow instruments are still starting', async () => {
    const { service, calls } = ownership({ acquire: async () => 1n, startDelayMs: 300 });

    await service.onApplicationBootstrap();
    const renewedBeforeLastStart = calls.renewed.filter((key) => key.endsWith(':ABC')).length;
    await service.onModuleDestroy();

    expect(calls.started).toEqual(['ABC', 'DEF', 'XYZ']);
    expect(renewedBeforeLastStart).toBeGreaterThanOrEqual(3);
    expect(calls.stopped.sort()).toEqual(['ABC', 'DEF', 'XYZ']);
  });

  it('stops and releases an instrument whose start was still running at shutdown', async () => {
    let attempts = 0;
    const { service, calls } = ownership({
      acquire: async (key) => (key.endsWith(':ABC') && ++attempts > 1 ? 1n : null),
      startDelayMs: 300,
    });
    await service.onApplicationBootstrap();
    await sleep(120);

    await service.onModuleDestroy();

    expect(calls.started).toEqual(['ABC']);
    expect(calls.stopped).toEqual(['ABC']);
    expect(calls.released).toEqual(['lock:instrument:ABC']);
  });

  it('does not keep a book running after losing the lease while it was starting', async () => {
    let holder: 'self' | 'other' | null = null;
    let token = 0n;
    let slowStart = true;
    const lock = {
      acquire: async (key: string) => {
        if (!key.endsWith(':ABC') || holder !== null) return null;
        holder = 'self';
        return ++token;
      },
      renew: async (key: string) => !key.endsWith(':ABC') || holder === 'self',
      release: async () => {
        holder = null;
        return true;
      },
      raiseFence: async () => undefined,
    } as unknown as RedisLockService;
    const runners = new Map<string, InstrumentLease>();
    const engine = {
      startInstrument: async (instrument: string, lease: InstrumentLease) => {
        if (slowStart) {
          holder = 'other';
          await sleep(300);
        }
        if (runners.has(instrument)) return;
        runners.set(instrument, lease);
      },
      stopInstrument: async (instrument: string) => {
        runners.delete(instrument);
      },
    } as unknown as MatchingEngineService;
    const service = new InstrumentOwnershipService(lock, engine);

    await service.onApplicationBootstrap();
    slowStart = false;
    holder = null;
    await sleep(200);
    const stale = [...runners.values()].find((lease) => !lease.isValid());
    if (stale) {
      runners.delete('ABC');
      stale.onFenced(new FencedOutError('ABC', stale.fence, null));
      await sleep(200);
    }
    const owned = service.ownedInstruments();
    const running = [...runners.keys()];
    await service.onModuleDestroy();

    expect(owned).toEqual(['ABC']);
    expect(running).toEqual(['ABC']);
    expect(stale).toBeUndefined();
  });

  it('starts even when Redis is unreachable at boot and keeps trying', async () => {
    let attempts = 0;
    const { service, calls } = ownership({
      acquire: async () => {
        attempts++;
        throw new Error('connect ECONNREFUSED');
      },
      startDelayMs: 0,
    });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    await sleep(160);
    await service.onModuleDestroy();

    expect(attempts).toBeGreaterThan(1);
    expect(calls.started).toEqual([]);
  });
});
