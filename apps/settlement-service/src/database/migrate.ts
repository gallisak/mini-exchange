import { DataSource } from 'typeorm';
import { intEnv } from '../common/env';
import { migrationDataSourceOptions } from './data-source';

const LOCK_RETRY_EVERY_MS = 5_000;

export async function createDatabaseIfMissing(): Promise<void> {
  const name = process.env.LEDGER_DATABASE_NAME ?? 'ledger';
  const admin = await new DataSource(migrationDataSourceOptions('postgres')).initialize();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.length === 0) {
      await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.destroy();
  }
}

async function runMigrations(): Promise<void> {
  const dataSource = await new DataSource(migrationDataSourceOptions()).initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

export async function migrate(
  retryForMs = intEnv('MIGRATION_LOCK_RETRY_MS', 600_000, 0),
  retryEveryMs = LOCK_RETRY_EVERY_MS,
): Promise<void> {
  await createDatabaseIfMissing();
  const deadline = Date.now() + retryForMs;
  for (;;) {
    try {
      return await runMigrations();
    } catch (error) {
      if (!/lock timeout/.test((error as Error).message) || Date.now() >= deadline) throw error;
      console.error(`A migration waited too long for a lock, trying again: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryEveryMs));
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
