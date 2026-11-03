import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';

export function redisClient(): Redis {
  return new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
}

export async function resetState(): Promise<void> {
  const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  await dataSource.query(
    `TRUNCATE "ledger_entries", "ledger_transactions", "accounts", "settled_trades" RESTART IDENTITY CASCADE`,
  );
  await dataSource.destroy();

  const redis = redisClient();
  await redis.flushdb();
  await redis.quit();
}

export async function eventually(assertion: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);
