import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { intEnv } from '../common/env';
import { Account } from '../ledger/entities/account.entity';
import { LedgerTransaction } from '../ledger/entities/ledger-transaction.entity';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { SettledTrade } from '../ledger/entities/settled-trade.entity';
import { ReconciliationCheckpoint } from '../reconciliation/reconciliation-checkpoint.entity';
import { UnresolvedPeriod } from '../reconciliation/unresolved-period.entity';

export const entities = [
  Account,
  LedgerTransaction,
  LedgerEntry,
  SettledTrade,
  ReconciliationCheckpoint,
  UnresolvedPeriod,
];

function databaseTimeouts(): Record<string, number> {
  const statement = intEnv('DATABASE_STATEMENT_TIMEOUT_MS', 60_000, 0);
  return {
    connectionTimeoutMillis: intEnv('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    ...(statement > 0
      ? {
          statement_timeout: statement,
          query_timeout: statement + 5_000,
          lock_timeout: intEnv('DATABASE_LOCK_TIMEOUT_MS', 10_000),
          idle_in_transaction_session_timeout: statement,
        }
      : {}),
  };
}

export function buildDataSourceOptions(database = process.env.LEDGER_DATABASE_NAME ?? 'ledger'): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.LEDGER_DATABASE_HOST,
    port: intEnv('LEDGER_DATABASE_PORT', 5432),
    username: process.env.LEDGER_DATABASE_USER,
    password: process.env.LEDGER_DATABASE_PASSWORD,
    database,
    entities,
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    synchronize: false,
    extra: databaseTimeouts(),
  };
}

export default new DataSource(buildDataSourceOptions());
