import { INestApplication } from '@nestjs/common';
import { InstrumentOwnershipService } from '../../src/orders/engine/instrument-ownership.service';
import { RedisService } from '../../src/redis/redis.service';
import { createApp, eventually, resetState } from './harness';

describe('lease renewal while Redis does not answer', () => {
  const saved = { ...process.env };
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    Object.assign(process.env, { LOCK_TTL_MS: '2000', LOCK_RENEW_INTERVAL_MS: '500', LOCK_ACQUIRE_INTERVAL_MS: '200' });
    app = await createApp();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    process.env = { ...saved };
  });

  it('gives up an instrument whose renewal is never answered and takes it back once Redis answers again', async () => {
    const ownership = app.get(InstrumentOwnershipService);
    await eventually(async () => expect(ownership.ownedInstruments()).toContain('ABC'));
    const client = app.get(RedisService).client;
    const evaluate = client.eval.bind(client) as (...args: unknown[]) => Promise<unknown>;
    let hanging = true;
    jest.spyOn(client, 'eval').mockImplementation(((...args: unknown[]) =>
      hanging && String(args[0]).includes('PEXPIRE') ? new Promise(() => undefined) : evaluate(...args)) as never);

    await eventually(async () => expect(ownership.ownedInstruments()).not.toContain('ABC'), 10_000);
    hanging = false;

    await eventually(async () => expect(ownership.ownedInstruments()).toContain('ABC'), 10_000);
  });
});
