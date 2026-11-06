import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { intEnv } from '../common/env';
import { clientWithReadTimeout } from './timed-client';
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

const READ_TIMEOUT_MARGIN_MS = 5_000;

function databaseTimeouts(statement: number): Record<string, unknown> {
  return {
    Client: clientWithReadTimeout(statement > 0 ? statement + READ_TIMEOUT_MARGIN_MS : 0),
    connectionTimeoutMillis: intEnv('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    lock_timeout: intEnv('DATABASE_LOCK_TIMEOUT_MS', 10_000, 0),
    ...(statement > 0
      ? { statement_timeout: statement, idle_in_transaction_session_timeout: statement }
      : {}),
  };
}

export function reconciliationDataSourceOptions(): DataSourceOptions {
  const options = buildDataSourceOptions(undefined, intEnv('RECONCILIATION_STATEMENT_TIMEOUT_MS', 600_000, 0));
  return { ...options, extra: { ...options.extra, max: 8 } } as DataSourceOptions;
}

export function buildDataSourceOptions(
  database = process.env.LEDGER_DATABASE_NAME ?? 'ledger',
  statementTimeoutMs = intEnv('DATABASE_STATEMENT_TIMEOUT_MS', 60_000, 0),
): DataSourceOptions {
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
    extra: databaseTimeouts(statementTimeoutMs),
  };
}

export function migrationDataSourceOptions(database?: string): DataSourceOptions {
  return buildDataSourceOptions(database, 0);
}

export default new DataSource(migrationDataSourceOptions());
