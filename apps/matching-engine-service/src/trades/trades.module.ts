import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradeRecord } from '../orders/entities/trade-record.entity';
import { InstrumentState } from '../orders/entities/instrument-state.entity';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';

@Module({
  imports: [TypeOrmModule.forFeature([TradeRecord, InstrumentState])],
  controllers: [TradesController],
  providers: [TradesService],
})
export class TradesModule {}
