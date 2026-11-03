import { InstrumentOwnershipService } from '../src/orders/engine/instrument-ownership.service';
import { RedisLockService } from '../src/locks/redis-lock.service';
import { MatchingEngineService } from '../src/orders/engine/matching-engine.service';

describe('instrument ownership identity', () => {
  const original = process.env.INSTANCE_ID;

  afterEach(() => {
    process.env.INSTANCE_ID = original;
  });

  it('gives two processes started with the same INSTANCE_ID different lock identities', () => {
    process.env.INSTANCE_ID = 'engine-1';
    const identity = () =>
      (
        new InstrumentOwnershipService(
          {} as RedisLockService,
          {} as MatchingEngineService,
        ) as unknown as { ownerId: string }
      ).ownerId;

    const [first, second] = [identity(), identity()];

    expect(first).not.toBe(second);
    expect(first.startsWith('engine-1')).toBe(true);
  });
});
