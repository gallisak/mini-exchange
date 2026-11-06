import { DataSource } from 'typeorm';
import { EngineClient } from '../src/reconciliation/engine-client';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service';
import { SettlementBacklog } from '../src/reconciliation/settlement-backlog';

describe('numeric settings', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses a reconciliation lag that is not a number of milliseconds', () => {
    process.env.RECONCILIATION_LAG_MS = 'one minute';

    expect(() => new ReconciliationService({} as DataSource, {} as EngineClient, {} as SettlementBacklog)).toThrow(
      'RECONCILIATION_LAG_MS',
    );
  });

  it('refuses an engine timeout that is not a number of milliseconds when it starts', () => {
    process.env.ENGINE_TIMEOUT_MS = '5s';

    expect(() => new EngineClient()).toThrow('ENGINE_TIMEOUT_MS');
  });
});
