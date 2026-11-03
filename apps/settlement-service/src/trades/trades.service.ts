import { ConflictException, Injectable } from '@nestjs/common';
import { SettleTradeDto } from './dto/settle-trade.dto';
import { LedgerService, SettlementResult } from '../ledger/ledger.service';
import { TradeConflictError } from '../ledger/trade-conflict.error';

@Injectable()
export class TradesService {
  constructor(private readonly ledger: LedgerService) {}

  async settle(dto: SettleTradeDto): Promise<{ tradeId: string; status: SettlementResult }> {
    try {
      return { tradeId: dto.tradeId, status: await this.ledger.settleTrade(dto) };
    } catch (error) {
      if (error instanceof TradeConflictError) throw new ConflictException(error.message);
      throw error;
    }
  }
}
