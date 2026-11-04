import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.client.eval(HIT, 1, `ratelimit:${key}`, windowMs)) as [
      number,
      number,
    ];
    return { allowed: count <= limit, retryAfterMs: ttl > 0 ? ttl : windowMs };
  }
}
