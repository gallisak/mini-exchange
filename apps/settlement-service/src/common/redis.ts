import Redis, { RedisOptions } from 'ioredis';

export function createRedis(options: RedisOptions = {}): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    retryStrategy: (attempt) => Math.min(attempt * 50, 500),
    ...options,
  });
}

export async function closeRedis(client: Redis | undefined): Promise<void> {
  if (!client || client.status === 'end') return;
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  await client.quit().catch(() => client.disconnect());
}
