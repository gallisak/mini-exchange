import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { closeRedis, createRedis } from '../common/redis';

export const WALLET_CHANNEL = 'wallets:updates';

@Injectable()
export class WalletNotifier implements OnApplicationShutdown {
  private readonly redis = createRedis({ lazyConnect: true });

  async announce(tradeId: string, ownerIds: string[]): Promise<void> {
    for (const ownerId of new Set(ownerIds)) {
      await this.redis.publish(WALLET_CHANNEL, JSON.stringify({ ownerId, tradeId }));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'wait') return;
    await closeRedis(this.redis);
  }
}
