import { EngineProcess, api, lockOwner, startEngine, stopEngine, waitForOwner } from './engines';
import { eventually, resetState } from './harness';

const FAST_LEASE = {
  LOCK_TTL_MS: '2000',
  LOCK_RENEW_INTERVAL_MS: '500',
  LOCK_ACQUIRE_INTERVAL_MS: '200',
};

const LONG_LEASE = {
  LOCK_TTL_MS: '30000',
  LOCK_RENEW_INTERVAL_MS: '10000',
  LOCK_ACQUIRE_INTERVAL_MS: '200',
};

describe('instrument failover between engine processes', () => {
  const engines: EngineProcess[] = [];

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => stopEngine(engine, 'SIGKILL')));
  });

  async function startPair(env: Record<string, string>) {
    const owner = await startEngine('engine-a', 4101, env);
    engines.push(owner);
    await waitForOwner('ABC', 'engine-a');
    const standby = await startEngine('engine-b', 4102, env);
    engines.push(standby);
    return { owner, standby };
  }

  it('lets another instance take over an instrument after its owner is killed', async () => {
    const { owner, standby } = await startPair(FAST_LEASE);
    const client = api(standby);
    const [seller, buyer] = [await client.register(), await client.register()];
    await client.submit(seller, { side: 'sell', price: '100.00', quantity: '1' });
    await eventually(async () => expect(await client.orders(seller)).toHaveLength(1));

    await stopEngine(owner, 'SIGKILL');
    const killedAt = Date.now();
    await client.submit(buyer, { side: 'buy', price: '100.00', quantity: '1' });

    await eventually(async () => {
      const [buy] = await client.orders(buyer);
      expect(buy?.status).toBe('filled');
    }, 15000);
    expect(Date.now() - killedAt).toBeLessThan(8000);
    expect(await lockOwner('ABC')).toMatch(/^engine-b/);
    expect((await client.orders(seller))[0].status).toBe('filled');
  });

  it('hands an instrument over at once when its owner shuts down gracefully', async () => {
    const { owner, standby } = await startPair(LONG_LEASE);
    const client = api(standby);
    const user = await client.register();

    await stopEngine(owner, 'SIGTERM');
    const stoppedAt = Date.now();
    await client.submit(user, { side: 'buy', price: '100.00', quantity: '1' });

    await eventually(async () => expect(await client.orders(user)).toHaveLength(1), 5000);
    expect(Date.now() - stoppedAt).toBeLessThan(5000);
    expect(await lockOwner('ABC')).toMatch(/^engine-b/);
  });
});
