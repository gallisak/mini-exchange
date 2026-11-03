import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TradeConsumerService } from './trade-consumer.service';

@Module({
  imports: [LedgerModule],
  providers: [TradeConsumerService],
})
export class ConsumerModule {}
