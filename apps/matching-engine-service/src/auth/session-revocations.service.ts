import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { withTimeout } from '../common/with-timeout';

export const LOGOUT_CHANNEL = 'auth:logouts';
const REVOCATION_TTL_MS = 16 * 60_000;
const REDIS_TIMEOUT_MS = 1_000;

export function revokedSessionKey(sessionId: string): string {
  return `auth:revoked-session:${sessionId}`;
}

@Injectable()
export class SessionRevocations {
  constructor(private readonly redis: RedisService) {}

  async revoke(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const commands = this.redis.client.multi();
    for (const sessionId of sessionIds) {
      commands.set(revokedSessionKey(sessionId), '1', 'PX', REVOCATION_TTL_MS);
    }
    for (const sessionId of sessionIds) commands.publish(LOGOUT_CHANNEL, sessionId);
    const results = await withTimeout(commands.exec(), REDIS_TIMEOUT_MS, 'Redis').catch(() => null);
    if (!results || results.some(([error]) => error)) {
      throw new ServiceUnavailableException('Could not end the access of the session, try again');
    }
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const revoked = await withTimeout(
      this.redis.client.exists(revokedSessionKey(sessionId)),
      REDIS_TIMEOUT_MS,
      'Redis',
    ).catch(() => {
      throw new ServiceUnavailableException('Could not check the session, try again');
    });
    return revoked === 1;
  }
}
