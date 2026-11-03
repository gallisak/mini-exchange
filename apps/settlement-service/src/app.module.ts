import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradesModule } from './trades/trades.module';
import { buildDataSourceOptions } from './database/data-source';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({ useFactory: () => buildDataSourceOptions() }),
    TradesModule,
  ],
})
export class AppModule {}
