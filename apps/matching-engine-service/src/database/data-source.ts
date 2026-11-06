import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { intEnv } from '../common/env';
import { User } from '../auth/entities/user.entity';
import { RefreshSession } from '../auth/entities/refresh-session.entity';
import { SessionRevocation } from '../auth/entities/session-revocation.entity';
import { Order } from '../orders/entities/order.entity';
import { TradeRecord } from '../orders/entities/trade-record.entity';
import { InstrumentState } from '../orders/entities/instrument-state.entity';
import { OutboxMessage } from '../outbox/outbox-message.entity';

export const entities = [
  User,
  RefreshSession,
  SessionRevocation,
  Order,
  TradeRecord,
  InstrumentState,
  OutboxMessage,
];

function databaseTimeouts(statement: number): Record<string, number | boolean> {
  return {
    connectionTimeoutMillis: intEnv('DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    lock_timeout: intEnv('DATABASE_LOCK_TIMEOUT_MS', 10_000, 0),
    ...(statement > 0
      ? { statement_timeout: statement, idle_in_transaction_session_timeout: statement }
      : {}),
  };
}

export function buildDataSourceOptions(
  statementTimeoutMs = intEnv('DATABASE_STATEMENT_TIMEOUT_MS', 60_000, 0),
): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: intEnv('DATABASE_PORT', 5432),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    entities,
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    migrationsTransactionMode: 'each',
    synchronize: false,
    extra: databaseTimeouts(statementTimeoutMs),
  };
}

export default new DataSource(buildDataSourceOptions());
