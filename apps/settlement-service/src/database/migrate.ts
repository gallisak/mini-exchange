import { DataSource } from 'typeorm';
import { intEnv } from '../common/env';
import { migrationDataSourceOptions } from './data-source';

const LOCK_NOT_AVAILABLE = '55P03';
const FIRST_PAUSE_MS = 5_000;
const LONGEST_PAUSE_MS = 30_000;

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

export function pauseBeforeRetry(attempt: number, firstPauseMs = FIRST_PAUSE_MS, jitter = Math.random()): number {
  const pause = Math.min(firstPauseMs * 2 ** attempt, LONGEST_PAUSE_MS);
  return Math.round(pause * (0.5 + jitter / 2));
}

export async function migrate(
  retryForMs = intEnv('MIGRATION_LOCK_RETRY_MS', 600_000, 0),
  firstPauseMs = FIRST_PAUSE_MS,
): Promise<void> {
  await createDatabaseIfMissing();
  const deadline = Date.now() + retryForMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runMigrations();
    } catch (error) {
      if ((error as { code?: unknown }).code !== LOCK_NOT_AVAILABLE || Date.now() >= deadline) throw error;
      console.error(`A migration waited too long for a lock, trying again: ${(error as Error).message}`);
    }
    const pause = Math.min(pauseBeforeRetry(attempt, firstPauseMs), Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
