import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SettleTradeDto } from './dto/settle-trade.dto';
import { LedgerService, SettlementResult } from '../ledger/ledger.service';
import { TradeConflictError } from '../ledger/trade-conflict.error';

@Injectable()
export class TradesService {
  constructor(private readonly ledger: LedgerService) {}

  async settle(dto: SettleTradeDto): Promise<{ tradeId: string; status: SettlementResult }> {
    let status: SettlementResult;
    try {
      status = await this.ledger.settle(dto);
    } catch (error) {
      if (error instanceof TradeConflictError) throw new ConflictException(error.message);
      throw error;
    }
    try {
      await this.ledger.announce(dto);
    } catch {
      throw new ServiceUnavailableException(
        'The trade is booked but its wallets could not be announced; retry the same request',
      );
    }
    return { tradeId: dto.tradeId, status };
  }
}
