import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { buildDataSourceOptions } from './database/data-source';
import { RedisModule } from './redis/redis.module';
import { OutboxModule } from './outbox/outbox.module';
import { TradesModule } from './trades/trades.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => buildDataSourceOptions() }),
    RedisModule,
    AuthModule,
    OrdersModule,
    OutboxModule,
    TradesModule,
  ],
})
export class AppModule {}
