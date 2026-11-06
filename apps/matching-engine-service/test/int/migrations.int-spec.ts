import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { RefreshSessionsCreatedIndex1793845000000 } from '../../src/database/migrations/1793845000000-RefreshSessionsCreatedIndex';
import { RepairRefreshSessionsCreatedIndex1793846000000 } from '../../src/database/migrations/1793846000000-RepairRefreshSessionsCreatedIndex';
import { resetState } from './harness';

describe('an index built concurrently', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  });

  afterEach(async () => {
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
    const migration = new RefreshSessionsCreatedIndex1793845000000();
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.query(`SET lock_timeout = 300`);
    try {
      await expect(migration.up(runner)).rejects.toThrow(/lock timeout/);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
      await runner.query(`RESET lock_timeout`);
      await runner.release();
    }

    expect((await index())?.valid).toBe(false);
    await run(migration);
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
