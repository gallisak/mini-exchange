export type RateLimitName = 'ORDER' | 'AUTH' | 'PUBLIC';

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
  by: 'user' | 'ip';
}

const DEFAULTS: Record<RateLimitName, RateLimitPolicy> = {
  ORDER: { limit: 20, windowMs: 1000, by: 'user' },
  AUTH: { limit: 10, windowMs: 60_000, by: 'ip' },
  PUBLIC: { limit: 100, windowMs: 1000, by: 'ip' },
};

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export function rateLimitPolicy(name: RateLimitName): RateLimitPolicy {
  const defaults = DEFAULTS[name];
  return {
    by: defaults.by,
    limit: positive(process.env[`${name}_RATE_LIMIT`], defaults.limit),
    windowMs: positive(process.env[`${name}_RATE_WINDOW_MS`], defaults.windowMs),
  };
}
