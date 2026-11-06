import { randomUUID } from 'crypto';
import { DataSource, DataSourceOptions } from 'typeorm';
import migrationDataSource, { buildDataSourceOptions } from '../../src/database/data-source';
import { RefreshSessionsCreatedIndex1793845000000 } from '../../src/database/migrations/1793845000000-RefreshSessionsCreatedIndex';
import { RepairRefreshSessionsCreatedIndex1793846000000 } from '../../src/database/migrations/1793846000000-RepairRefreshSessionsCreatedIndex';
import { resetState } from './harness';

describe('the data source of the migration commands', () => {
  it('has no statement limit, whichever way the migrations are started', async () => {
    const connected = await migrationDataSource.initialize();
    try {
      expect(await connected.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '0' }]);
    } finally {
      await connected.destroy();
    }
  });
});

describe('an index built concurrently', () => {
  let dataSource: DataSource;
  const savedLockTimeout = process.env.DATABASE_INDEX_LOCK_TIMEOUT_MS;

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  });

  afterEach(async () => {
    if (savedLockTimeout === undefined) delete process.env.DATABASE_INDEX_LOCK_TIMEOUT_MS;
    else process.env.DATABASE_INDEX_LOCK_TIMEOUT_MS = savedLockTimeout;
    await dataSource.query(`DROP INDEX IF EXISTS "IDX_refresh_sessions_created"`);
    await dataSource.query(`CREATE INDEX "IDX_refresh_sessions_created" ON "refresh_sessions" ("createdAt")`);
    await dataSource.destroy();
  });

  const index = async () => {
    const rows: { valid: boolean; definition: string }[] = await dataSource.query(
      `SELECT i."indisvalid" AS "valid", pg_get_indexdef(i.indexrelid) AS "definition"
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'IDX_refresh_sessions_created'`,
    );
    return rows[0] ?? null;
  };

  async function run(migration: { up(runner: ReturnType<DataSource['createQueryRunner']>): Promise<void> }) {
    const runner = dataSource.createQueryRunner();
    try {
      await migration.up(runner);
    } finally {
      await runner.release();
    }
  }

  it('builds again an index that an interrupted build left invalid, instead of taking it as done', async () => {
    const user = randomUUID();
    for (let n = 0; n < 2; n += 1) {
      await dataSource.query(
        `INSERT INTO "refresh_sessions" ("id", "userId", "familyId", "tokenHash") VALUES ($1, $2, $3, 'hash')`,
        [randomUUID(), user, randomUUID()],
      );
    }
    await dataSource.query(`DROP INDEX "IDX_refresh_sessions_created"`);
    await expect(
      dataSource.query(`CREATE UNIQUE INDEX CONCURRENTLY "IDX_refresh_sessions_created" ON "refresh_sessions" ("userId")`),
    ).rejects.toThrow();
    expect((await index())?.valid).toBe(false);

    await run(new RefreshSessionsCreatedIndex1793845000000());

    expect(await index()).toMatchObject({ valid: true, definition: expect.stringContaining('("createdAt")') });
  });

  it('builds the index on the next run after its own build timed out waiting for a lock', async () => {
    await dataSource.query(`DROP INDEX "IDX_refresh_sessions_created"`);
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(`INSERT INTO "refresh_sessions" ("id", "userId", "familyId", "tokenHash") VALUES ($1, $2, $3, 'hash')`, [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]);
    process.env.DATABASE_INDEX_LOCK_TIMEOUT_MS = '300';
    const migration = new RefreshSessionsCreatedIndex1793845000000();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    try {
      await expect(migration.up(runner)).rejects.toThrow(/lock timeout/);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
      await runner.release();
    }

    expect((await index())?.valid).toBe(false);
    await run(migration);
    expect((await index())?.valid).toBe(true);
  });

  it('outwaits a transaction longer than the lock limit of every other statement, then restores that limit', async () => {
    await dataSource.query(`DROP INDEX "IDX_refresh_sessions_created"`);
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(`INSERT INTO "refresh_sessions" ("id", "userId", "familyId", "tokenHash") VALUES ($1, $2, $3, 'hash')`, [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]);
    const shortLocks = await new DataSource({
      ...buildDataSourceOptions(),
      extra: { ...buildDataSourceOptions().extra, lock_timeout: 300 },
    } as DataSourceOptions).initialize();
    const runner = shortLocks.createQueryRunner();
    await runner.connect();
    try {
      const building = new RefreshSessionsCreatedIndex1793845000000().up(runner);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await holder.rollbackTransaction();
      await building;

      expect(await runner.query('SHOW lock_timeout')).toEqual([{ lock_timeout: '300ms' }]);
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
      await runner.release();
      await shortLocks.destroy();
    }

    expect((await index())?.valid).toBe(true);
  });

  it('keeps a valid index as it is', async () => {
    await run(new RefreshSessionsCreatedIndex1793845000000());

    expect((await index())?.valid).toBe(true);
  });

  it('repairs an index left invalid by an install that already recorded the first index migration as done', async () => {
    const user = randomUUID();
    for (let n = 0; n < 2; n += 1) {
      await dataSource.query(
        `INSERT INTO "refresh_sessions" ("id", "userId", "familyId", "tokenHash") VALUES ($1, $2, $3, 'hash')`,
        [randomUUID(), user, randomUUID()],
      );
    }
    await dataSource.query(`DROP INDEX "IDX_refresh_sessions_created"`);
    await expect(
      dataSource.query(`CREATE UNIQUE INDEX CONCURRENTLY "IDX_refresh_sessions_created" ON "refresh_sessions" ("userId")`),
    ).rejects.toThrow();
    const [{ recorded }] = await dataSource.query(
      `SELECT COUNT(*)::int AS "recorded" FROM "migrations" WHERE "name" = 'RefreshSessionsCreatedIndex1793845000000'`,
    );
    expect(recorded).toBe(1);

    await run(new RepairRefreshSessionsCreatedIndex1793846000000());

    expect(await index()).toMatchObject({ valid: true, definition: expect.stringContaining('("createdAt")') });
  });
});
