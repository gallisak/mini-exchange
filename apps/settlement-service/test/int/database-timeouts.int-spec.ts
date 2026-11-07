import { DataSource } from 'typeorm';
import {
  buildDataSourceOptions,
  migrationDataSourceOptions,
  reconciliationDataSourceOptions,
} from '../../src/database/data-source';
import { migrate, pauseBeforeRetry } from '../../src/database/migrate';

const lockTimeout = (message = 'canceling statement due to lock timeout') =>
  Object.assign(new Error(message), { code: '55P03' });

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

  it('tries a migration again that gave up on a lock, so a long reconciliation does not fail a deploy', async () => {
    const run = jest
      .spyOn(DataSource.prototype, 'runMigrations')
      .mockRejectedValueOnce(lockTimeout())
      .mockResolvedValue([]);
    try {
      await migrate(60_000, 1);

      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
    }
  });

  it('stops trying a migration again once its time is up, and at once on any other failure', async () => {
    const run = jest.spyOn(DataSource.prototype, 'runMigrations');
    try {
      run.mockRejectedValue(lockTimeout());
      await expect(migrate(0, 1)).rejects.toThrow(/lock timeout/);
      run.mockClear();
      run.mockRejectedValue(new Error('column "x" does not exist'));
      await expect(migrate(60_000, 1)).rejects.toThrow(/does not exist/);
      expect(run).toHaveBeenCalledTimes(1);
      run.mockClear();
      run.mockRejectedValue(new Error('a message that only mentions a lock timeout'));
      await expect(migrate(60_000, 1)).rejects.toThrow(/mentions/);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });

  it('gives a migration a much shorter lock wait than other queries, so it holds up writes only briefly', async () => {
    delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    const dataSource = await new DataSource(migrationDataSourceOptions()).initialize();
    try {
      expect(await dataSource.query('SHOW lock_timeout')).toEqual([{ lock_timeout: '1500ms' }]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('waits ever longer between attempts, up to half a minute, and spreads them out', () => {
    expect([0, 1, 2, 3, 4, 10].map((attempt) => pauseBeforeRetry(attempt, 5_000, 1))).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ]);
    expect(pauseBeforeRetry(10, 5_000, 0)).toBe(15_000);
  });

  it('leaves writes waiting no longer than one attempt while a long read keeps a migration out', async () => {
    Object.assign(process.env, {
      MIGRATION_LOCK_TIMEOUT_MS: '200',
      DATABASE_LOCK_TIMEOUT_MS: '5000',
      DATABASE_STATEMENT_TIMEOUT_MS: '60000',
    });
    const writer = await new DataSource(buildDataSourceOptions()).initialize();
    const reader = writer.createQueryRunner();
    await writer.query('DROP TABLE IF EXISTS "migration_lock_probe"');
    await writer.query('CREATE TABLE "migration_lock_probe" ("id" int PRIMARY KEY, "n" int NOT NULL DEFAULT 0)');
    await writer.query('INSERT INTO "migration_lock_probe" ("id") VALUES (1), (2)');
    await reader.connect();
    await reader.startTransaction();
    await reader.query('SELECT * FROM "migration_lock_probe" WHERE "id" = 1 FOR SHARE');
    let attempts = 0;
    const run = jest.spyOn(DataSource.prototype, 'runMigrations').mockImplementation(async function (
      this: DataSource,
    ) {
      attempts += 1;
      await this.query('ALTER TABLE "migration_lock_probe" ADD COLUMN "added" int');
      return [];
    });
    let longestWrite = 0;
    let migrating = true;
    const writes = (async () => {
      while (migrating) {
        const started = Date.now();
        await writer.query('UPDATE "migration_lock_probe" SET "n" = "n" + 1 WHERE "id" = 2');
        longestWrite = Math.max(longestWrite, Date.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const migrated = migrate(60_000, 100);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await reader.commitTransaction();
      await migrated;
    } finally {
      migrating = false;
      await writes;
      run.mockRestore();
      await reader.release();
      await writer.query('DROP TABLE IF EXISTS "migration_lock_probe"');
      await writer.destroy();
    }

    expect(attempts).toBeGreaterThan(1);
    expect(longestWrite).toBeLessThan(600);
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
