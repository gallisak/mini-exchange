import 'reflect-metadata';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { RefreshSession } from '../auth/entities/refresh-session.entity';
import { Order } from '../orders/entities/order.entity';
import { TradeRecord } from '../orders/entities/trade-record.entity';
import { InstrumentState } from '../orders/entities/instrument-state.entity';
import { OutboxMessage } from '../outbox/outbox-message.entity';

export const entities = [User, RefreshSession, Order, TradeRecord, InstrumentState, OutboxMessage];

export function buildDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    entities,
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    synchronize: false,
  };
}

export default new DataSource(buildDataSourceOptions());
