import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { withTimeout } from '../common/with-timeout';

const LOCK_COMMAND_TIMEOUT_MS = 1_000;

const ACQUIRE = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])
end
return 0
`;

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RAISE_FENCE = `
if tonumber(redis.call('GET', KEYS[1]) or '0') < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1])
end
return redis.call('GET', KEYS[1])
`;

@Injectable()
export class RedisLockService {
  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, ownerId: string, ttlMs: number): Promise<bigint | null> {
    const token = (await this.run(this.redis.client.eval(ACQUIRE, 2, key, fenceKey(key), ownerId, ttlMs))) as number;
    return token > 0 ? BigInt(token) : null;
  }

  async renew(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    return (await this.run(this.redis.client.eval(RENEW, 1, key, ownerId, ttlMs))) === 1;
  }

  async release(key: string, ownerId: string): Promise<boolean> {
    return (await this.run(this.redis.client.eval(RELEASE, 1, key, ownerId))) === 1;
  }

  private run<T>(command: Promise<T>): Promise<T> {
    return withTimeout(command, LOCK_COMMAND_TIMEOUT_MS, 'Redis');
  }

  async raiseFence(key: string, atLeast: bigint): Promise<void> {
    await this.run(this.redis.client.eval(RAISE_FENCE, 1, fenceKey(key), atLeast.toString()));
  }
}

function fenceKey(key: string): string {
  return `${key}:fence`;
}
