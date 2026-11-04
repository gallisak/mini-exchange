import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

export const WALLET_CHANNEL = 'wallets:updates';

@Injectable()
export class WalletNotifier implements OnApplicationShutdown {
  private readonly logger = new Logger(WalletNotifier.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
  });

  async walletsChanged(tradeId: string, ownerIds: string[]): Promise<void> {
    try {
      for (const ownerId of new Set(ownerIds)) {
        await this.redis.publish(WALLET_CHANNEL, JSON.stringify({ ownerId, tradeId }));
      }
    } catch (error) {
      this.logger.warn(`Could not announce wallet changes for ${tradeId}: ${(error as Error).message}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'wait') return;
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
