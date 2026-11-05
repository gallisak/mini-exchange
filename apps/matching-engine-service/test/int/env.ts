const defaults: Record<string, string> = {
  DATABASE_HOST: 'localhost',
  DATABASE_PORT: '55432',
  DATABASE_USER: 'exchange',
  DATABASE_PASSWORD: 'exchange',
  DATABASE_NAME: 'exchange',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '56379',
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  ENGINE_INTERNAL_KEY: 'test-engine-key',
  INSTANCE_ID: 'engine-test',
  BOOK_HEARTBEAT_MS: '500',
  ORDER_RATE_LIMIT: '100000',
  AUTH_RATE_LIMIT: '100000',
  PUBLIC_RATE_LIMIT: '100000',
  SNAPSHOT_RATE_LIMIT: '100000',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
