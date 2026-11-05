import { Injectable, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { closeRedis, createRedis } from '../common/redis';

export function roleChangedKey(userId: string): string {
  return `auth:role-changed:${userId}`;
}

@Injectable()
export class RoleChanges implements OnApplicationShutdown {
  private readonly redis = createRedis({ lazyConnect: true, maxRetriesPerRequest: 1 });

  async changedSince(userId: string, issuedAtSeconds: number): Promise<boolean> {
    let changedAt: string | null;
    try {
      changedAt = await this.redis.get(roleChangedKey(userId));
    } catch {
      throw new ServiceUnavailableException('Service temporarily unavailable, try again shortly');
    }
    return changedAt !== null && Number(changedAt) >= issuedAtSeconds * 1000;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'wait') return;
    await closeRedis(this.redis);
  }
}
