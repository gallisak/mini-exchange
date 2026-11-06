import { DataSource } from 'typeorm';
import { migrationDataSourceOptions } from './data-source';

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

export async function migrate(): Promise<void> {
  await createDatabaseIfMissing();
  const dataSource = await new DataSource(migrationDataSourceOptions()).initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
