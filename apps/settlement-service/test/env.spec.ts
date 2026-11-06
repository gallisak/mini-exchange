import { readFileSync } from 'fs';
import { resolve } from 'path';
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

  it('waits for a trade summary longer than nginx does, and nginx longer than the engine lets a query run', () => {
    const file = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8');
    const setting = (path: string, name: string) =>
      Number(new RegExp(`^${name}=(\\d+)$`, 'm').exec(file(path))?.[1]);
    const nginx = Number(
      /location \/trades\/summary \{[^}]*proxy_read_timeout (\d+)s/.exec(file('../docker/nginx/nginx.conf'))?.[1],
    );
    const engineLimit = setting('matching-engine-service/.env.example', 'DATABASE_STATEMENT_TIMEOUT_MS') + 5_000;
    delete process.env.ENGINE_TIMEOUT_MS;
    const settlementWait = (new EngineClient() as unknown as { timeoutMs: number }).timeoutMs;

    expect(nginx * 1000).toBeGreaterThan(engineLimit);
    expect(settlementWait).toBeGreaterThan(nginx * 1000);
    expect(setting('settlement-service/.env.example', 'ENGINE_TIMEOUT_MS')).toBe(settlementWait);
  });
});
