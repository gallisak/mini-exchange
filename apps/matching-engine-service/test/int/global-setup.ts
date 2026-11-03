import './env';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';

export default async function globalSetup(): Promise<void> {
  const dataSource = new DataSource(buildDataSourceOptions());
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
