import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderBookService } from './order-book.service';
import { OrdersGateway } from './gateway/orders.gateway';
import { Order } from './entities/order.entity';
import { TradeRecord } from './entities/trade-record.entity';
import { InstrumentState } from './entities/instrument-state.entity';
import { RedisLockService } from '../locks/redis-lock.service';
import { CommandStreamService } from './engine/command-stream.service';
import { MatchingEngineService } from './engine/matching-engine.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, TradeRecord, InstrumentState])],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderBookService,
    OrdersGateway,
    RedisLockService,
    CommandStreamService,
    MatchingEngineService,
  ],
  exports: [OrderBookService],
})
export class OrdersModule {}
