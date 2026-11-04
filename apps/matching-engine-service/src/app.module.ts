import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { buildDataSourceOptions } from './database/data-source';
import { RedisModule } from './redis/redis.module';
import { OutboxModule } from './outbox/outbox.module';
import { TradesModule } from './trades/trades.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { TraceMiddleware } from './observability/trace.middleware';
import { OpsModule } from './ops/ops.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => buildDataSourceOptions() }),
    RedisModule,
    RateLimitModule,
    AuthModule,
    OrdersModule,
    OutboxModule,
    TradesModule,
    OpsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
