import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });

  createConnection(): Redis {
    return this.client.duplicate();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
