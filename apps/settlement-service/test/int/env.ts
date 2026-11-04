const defaults: Record<string, string> = {
  LEDGER_DATABASE_HOST: 'localhost',
  LEDGER_DATABASE_PORT: '55432',
  LEDGER_DATABASE_USER: 'exchange',
  LEDGER_DATABASE_PASSWORD: 'exchange',
  LEDGER_DATABASE_NAME: 'ledger',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '56379',
  JWT_ACCESS_SECRET: 'test-access-secret',
  SETTLEMENT_INTERNAL_KEY: 'test-internal-key',
  RECONCILIATION_API_KEY: 'test-reconciliation-key',
  INSTRUMENTS: 'ABC,DEF,XYZ',
  CONSUMER_BLOCK_MS: '200',
  CONSUMER_RETRY_IDLE_MS: '500',
  CONSUMER_RECLAIM_INTERVAL_MS: '200',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
