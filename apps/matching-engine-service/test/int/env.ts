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
  INSTANCE_ID: 'engine-test',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
