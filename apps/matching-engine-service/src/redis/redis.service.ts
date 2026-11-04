import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

export async function closeRedis(client: Redis | undefined): Promise<void> {
  if (!client || client.status === 'end') return;
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }
  await client.quit().catch(() => client.disconnect());
}

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: Number(process.env.REDIS_MAX_RETRIES ?? 3),
    retryStrategy: (attempt) => Math.min(attempt * 50, 500),
  });

  isReady(): boolean {
    return this.client.status === 'ready';
  }

  createConnection(): Redis {
    return this.client.duplicate();
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.client);
  }
}
