import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { OrdersModule } from '../orders/orders.module';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { DependencyUnavailableFilter } from './dependency-unavailable.filter';

@Module({
  imports: [OrdersModule],
  controllers: [OpsController],
  providers: [OpsService, { provide: APP_FILTER, useClass: DependencyUnavailableFilter }],
})
export class OpsModule {}
