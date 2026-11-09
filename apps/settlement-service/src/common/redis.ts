import Redis, { RedisOptions } from 'ioredis';
import { intEnv } from './env';

export function createRedis(options: RedisOptions = {}): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: intEnv('REDIS_PORT', 6379),
    retryStrategy: (attempt) => Math.min(attempt * 50, 500),
    ...options,
  });
}

export const READ_TIMEOUT_MARGIN_MS = 2_000;

export const commandTimeoutMs = () => intEnv('REDIS_COMMAND_TIMEOUT_MS', 5_000);

export function timedOut(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Command timed out');
}

const QUIT_TIMEOUT_MS = 1_000;

export async function closeRedis(client: Redis | undefined): Promise<void> {
  if (!client || client.status === 'end') return;
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    client.quit().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUIT_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  client.disconnect();
}
