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
  start?: (instrument: string) => Promise<unknown>;
  renew?: (key: string) => Promise<boolean>;
}

function ownership({ acquire, startDelayMs, start, renew }: Setup) {
  const leases = new Map<string, InstrumentLease>();
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
      return renew ? renew(key) : true;
    },
    release: async (key: string) => {
      calls.released.push(key);
      return true;
    },
    raiseFence: async () => undefined,
  } as unknown as RedisLockService;
  const engine = {
    isStopping: () => false,
    startInstrument: async (instrument: string, lease: InstrumentLease) => {
      leases.set(instrument, lease);
      await (start ? start(instrument) : sleep(startDelayMs));
      calls.started.push(instrument);
    },
    stopInstrument: async (instrument: string) => {
      calls.stopped.push(instrument);
    },
  } as unknown as MatchingEngineService;
  return { service: new InstrumentOwnershipService(lock, engine), calls, leases };
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
    const { service, calls } = ownership({ acquire: async () => 1n, startDelayMs: 500 });

    await service.onApplicationBootstrap();
    const renewedBeforeLastStart = calls.renewed.filter((key) => key.endsWith(':ABC')).length;
    await service.onModuleDestroy();

    expect(calls.started).toEqual(['ABC', 'DEF', 'XYZ']);
    expect(renewedBeforeLastStart).toBeGreaterThanOrEqual(3);
    expect(calls.stopped.sort()).toEqual(['ABC', 'DEF', 'XYZ']);
  });

  it('takes the other instruments over when one of them cannot start', async () => {
    const { service, calls } = ownership({
      acquire: async () => 1n,
      startDelayMs: 0,
      start: async (instrument) => {
        if (instrument === 'ABC') throw new Error('claiming the fence timed out');
      },
    });

    await service.onApplicationBootstrap();
    await service.onModuleDestroy();

    expect(calls.started.sort()).toEqual(['DEF', 'XYZ']);
    expect(calls.released).toContain('lock:instrument:ABC');
  });

  it('does not make the other instruments wait for one whose start is slow', async () => {
    const { service, calls } = ownership({
      acquire: async () => 1n,
      startDelayMs: 0,
      start: (instrument) => sleep(instrument === 'ABC' ? 1_500 : 0),
    });

    const booting = service.onApplicationBootstrap();
    await sleep(100);
    const startedMeanwhile = [...calls.started].sort();
    await booting;
    await service.onModuleDestroy();

    expect(startedMeanwhile).toEqual(['DEF', 'XYZ']);
    expect(calls.started.sort()).toEqual(['ABC', 'DEF', 'XYZ']);
  });

  it('renews each lease on its own, so a slow renewal of one instrument lets no other lease lapse', async () => {
    const { service, leases } = ownership({
      acquire: async () => 1n,
      startDelayMs: 0,
      renew: async (key) => {
        if (key.endsWith(':ABC')) await sleep(450);
        return true;
      },
    });
    await service.onApplicationBootstrap();

    const lapsed = new Set<string>();
    for (let n = 0; n < 50; n += 1) {
      for (const instrument of ['DEF', 'XYZ']) if (!leases.get(instrument)?.isValid()) lapsed.add(instrument);
      await sleep(20);
    }
    await service.onModuleDestroy();

    expect([...lapsed]).toEqual([]);
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
      isStopping: () => false,
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

  it('keeps renewing the other instruments while a lost one is still stopping', async () => {
    const renewed: string[] = [];
    let lost = false;
    let finishStop: () => void = () => undefined;
    const lock = {
      acquire: async (key: string) => (lost && key.endsWith(':ABC') ? null : 1n),
      renew: async (key: string) => {
        renewed.push(key);
        return !(lost && key.endsWith(':ABC'));
      },
      release: async () => true,
      raiseFence: async () => undefined,
    } as unknown as RedisLockService;
    const engine = {
      isStopping: () => false,
      startInstrument: async () => undefined,
      stopInstrument: (instrument: string) =>
        instrument === 'ABC'
          ? new Promise<void>((resolve) => (finishStop = resolve))
          : Promise.resolve(),
    } as unknown as MatchingEngineService;
    const service = new InstrumentOwnershipService(lock, engine);
    await service.onApplicationBootstrap();

    lost = true;
    await sleep(150);
    const before = renewed.filter((key) => key.endsWith(':DEF')).length;
    await sleep(400);
    const after = renewed.filter((key) => key.endsWith(':DEF')).length;
    finishStop();
    await service.onModuleDestroy();

    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  it('does not drop a lease it just took because a renewal of the older one answered late', async () => {
    const leases = new Map<string, InstrumentLease>();
    let answerRenewal: (() => void) | undefined;
    let token = 0n;
    const lock = {
      acquire: async (key: string) => (key.endsWith(':ABC') ? ++token : null),
      renew: async (key: string) => {
        if (!key.endsWith(':ABC') || token !== 1n) return true;
        await new Promise<void>((resolve) => (answerRenewal = resolve));
        return false;
      },
      release: async () => true,
      raiseFence: async () => undefined,
    } as unknown as RedisLockService;
    const engine = {
      isStopping: () => false,
      startInstrument: async (instrument: string, lease: InstrumentLease) => void leases.set(instrument, lease),
      stopInstrument: async () => undefined,
    } as unknown as MatchingEngineService;
    const service = new InstrumentOwnershipService(lock, engine);
    try {
      await service.onApplicationBootstrap();
      while (!answerRenewal) await sleep(10);

      leases.get('ABC')?.onFenced(new FencedOutError('ABC', 1n, 1n));
      while (token < 2n || !service.ownedInstruments().includes('ABC')) await sleep(10);
      answerRenewal();
      await sleep(200);

      expect(service.ownedInstruments()).toContain('ABC');
      expect(token).toBe(2n);
    } finally {
      answerRenewal?.();
      await service.onModuleDestroy();
    }
  });

  it('lets go of a lock whose acquisition Redis did not answer in time', async () => {
    const { service, calls } = ownership({
      acquire: async (key) => {
        if (key.endsWith(':ABC')) throw new Error('Redis did not answer within 1000 ms');
        return null;
      },
      startDelayMs: 0,
    });

    await service.onApplicationBootstrap();
    await service.onModuleDestroy();

    expect(calls.released).toContain('lock:instrument:ABC');
  });
});
