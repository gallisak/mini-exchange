import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { intEnv } from '../common/env';
import { Account } from '../ledger/entities/account.entity';
import { LedgerTransaction } from '../ledger/entities/ledger-transaction.entity';
import { LedgerEntry } from '../ledger/entities/ledger-entry.entity';
import { SettledTrade } from '../ledger/entities/settled-trade.entity';
import { ReconciliationCheckpoint } from '../reconciliation/reconciliation-checkpoint.entity';

export const entities = [Account, LedgerTransaction, LedgerEntry, SettledTrade, ReconciliationCheckpoint];

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
  };
}

export default new DataSource(buildDataSourceOptions());
