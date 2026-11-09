import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { closeRedis, commandTimeoutMs, createRedis, timedOut } from '../common/redis';

export const WALLET_CHANNEL = 'wallets:updates';

@Injectable()
export class WalletNotifier implements OnApplicationShutdown {
  private readonly redis = createRedis({ lazyConnect: true, commandTimeout: commandTimeoutMs() });

  async announce(tradeId: string, ownerIds: string[]): Promise<void> {
    try {
      for (const ownerId of new Set(ownerIds)) {
        await this.redis.publish(WALLET_CHANNEL, JSON.stringify({ ownerId, tradeId }));
      }
    } catch (error) {
      if (timedOut(error)) this.redis.disconnect(true);
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'wait') return;
    await closeRedis(this.redis);
  }
}
