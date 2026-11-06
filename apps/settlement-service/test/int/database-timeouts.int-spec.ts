import { DataSource } from 'typeorm';
import { buildDataSourceOptions, reconciliationDataSourceOptions } from '../../src/database/data-source';
import { migrate } from '../../src/database/migrate';

describe('a database that stops answering', () => {
  const saved = { ...process.env };
  let first: DataSource;
  let second: DataSource;

  beforeEach(async () => {
    Object.assign(process.env, { DATABASE_STATEMENT_TIMEOUT_MS: '500', DATABASE_LOCK_TIMEOUT_MS: '300' });
    first = await new DataSource(buildDataSourceOptions()).initialize();
    second = await new DataSource(buildDataSourceOptions()).initialize();
  });

  afterEach(async () => {
    process.env = { ...saved };
    await first.destroy();
    await second.destroy();
  });

  it('gives up on a query that runs too long instead of waiting forever', async () => {
    const started = Date.now();

    await expect(first.query('SELECT pg_sleep(5)')).rejects.toThrow(/statement timeout/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('gives up waiting for a lock someone else holds', async () => {
    const holder = first.createQueryRunner();
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(424242)');
    try {
      await expect(second.query('SELECT pg_advisory_lock(424242)')).rejects.toThrow(/lock timeout/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(424242)');
      await holder.release();
    }
  });

  it('runs migrations without the statement limit, however they are started', async () => {
    let limit: unknown;
    const run = jest.spyOn(DataSource.prototype, 'runMigrations').mockImplementation(async function (
      this: DataSource,
    ) {
      limit = await this.query('SHOW statement_timeout');
      return [];
    });
    try {
      await migrate();
    } finally {
      run.mockRestore();
    }

    expect(limit).toEqual([{ statement_timeout: '0' }]);
  });

  it('gives reconciliation its own, longer limit than every other query', async () => {
    Object.assign(process.env, { DATABASE_STATEMENT_TIMEOUT_MS: '60000', RECONCILIATION_STATEMENT_TIMEOUT_MS: '600000' });
    const reconciliation = await new DataSource(reconciliationDataSourceOptions()).initialize();
    const regular = await new DataSource(buildDataSourceOptions()).initialize();
    try {
      const [{ statement_timeout: long }] = await reconciliation.query('SHOW statement_timeout');
      const [{ statement_timeout: short }] = await regular.query('SHOW statement_timeout');

      expect([long, short]).toEqual(['10min', '1min']);
    } finally {
      await reconciliation.destroy();
      await regular.destroy();
    }
  });
});
