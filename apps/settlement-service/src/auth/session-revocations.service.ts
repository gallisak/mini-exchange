import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { closeRedis, createRedis } from '../common/redis';

const CHECK_TIMEOUT_MS = 1_000;

@Injectable()
export class SessionRevocations implements OnModuleDestroy {
  private readonly redis = createRedis({ maxRetriesPerRequest: 1 });

  async onModuleDestroy(): Promise<void> {
    await closeRedis(this.redis);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis did not answer')), CHECK_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([this.redis.exists(`auth:revoked-session:${sessionId}`), timeout])) === 1;
    } catch {
      throw new ServiceUnavailableException('Could not check the session, try again');
    } finally {
      clearTimeout(timer);
    }
  }
}
