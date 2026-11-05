import { DataSource } from 'typeorm';
import { EngineClient } from '../src/reconciliation/engine-client';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service';

describe('numeric settings', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses a reconciliation lag that is not a number of milliseconds', () => {
    process.env.RECONCILIATION_LAG_MS = 'one minute';
    const service = new ReconciliationService({} as DataSource, {} as EngineClient);

    expect(() => service.defaultPeriod()).toThrow('RECONCILIATION_LAG_MS');
  });

  it('refuses an engine timeout that is not a number of milliseconds', async () => {
    process.env.ENGINE_TIMEOUT_MS = '5s';

    await expect(new EngineClient().tradeTotals(new Date(0), new Date())).rejects.toThrow(
      'ENGINE_TIMEOUT_MS',
    );
  });
});
