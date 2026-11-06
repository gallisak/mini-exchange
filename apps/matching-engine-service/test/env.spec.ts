import { InstrumentOwnershipService } from '../src/orders/engine/instrument-ownership.service';
import { OutboxRelayService } from '../src/outbox/outbox-relay.service';
import { RedisLockService } from '../src/locks/redis-lock.service';
import { MatchingEngineService } from '../src/orders/engine/matching-engine.service';
import { RedisService } from '../src/redis/redis.service';
import { DataSource } from 'typeorm';
import { refuseSharedSecret } from '../src/common/env';

describe('numeric settings', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses to start the outbox relay with a poll interval that is not a number', () => {
    process.env.OUTBOX_POLL_MS = 'fast';

    expect(() => new OutboxRelayService({} as DataSource, {} as RedisService)).toThrow(
      'OUTBOX_POLL_MS',
    );
  });

  it('refuses a lock lease that is not a positive whole number of milliseconds', () => {
    for (const value of ['5s', '0', '-1', '1.5']) {
      process.env.LOCK_TTL_MS = value;

      expect(
        () =>
          new InstrumentOwnershipService({} as RedisLockService, {} as MatchingEngineService),
      ).toThrow('LOCK_TTL_MS');
    }
  });

  it('refuses the same secret for access and refresh tokens', () => {
    process.env.JWT_ACCESS_SECRET = 'one';
    process.env.JWT_REFRESH_SECRET = 'one';
    expect(() => refuseSharedSecret('JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET')).toThrow('must differ');

    process.env.JWT_REFRESH_SECRET = 'two';
    expect(() => refuseSharedSecret('JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET')).not.toThrow();
  });

  it('uses the default when a setting is not given', () => {
    delete process.env.LOCK_TTL_MS;

    expect(
      () => new InstrumentOwnershipService({} as RedisLockService, {} as MatchingEngineService),
    ).not.toThrow();
  });
});
