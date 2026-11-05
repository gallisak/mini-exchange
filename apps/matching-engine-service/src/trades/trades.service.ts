import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TradeRecord } from '../orders/entities/trade-record.entity';
import { PublicTrade, publicTrade } from './public-trade';

export interface InstrumentTradeTotals {
  instrument: string;
  count: number;
  quantity: string;
  notional: string;
}

export interface TradeSummary {
  from: string;
  to: string;
  firstTradeAt: string | null;
  instruments: InstrumentTradeTotals[];
}

@Injectable()
export class TradesService {
  constructor(@InjectRepository(TradeRecord) private readonly trades: Repository<TradeRecord>) {}

  async recent(instrument: string, limit = 50): Promise<PublicTrade[]> {
    const trades = await this.trades.find({
      where: { instrument },
      order: { seq: 'DESC' },
      take: limit,
    });
    return trades.map(publicTrade);
  }

  async summary(fromValue: string, toValue: string): Promise<TradeSummary> {
    const from = new Date(fromValue);
    const to = new Date(toValue);
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from must be earlier than to');
    }
    const rows: { instrument: string; count: string; quantity: string; notional: string }[] =
      await this.trades
        .createQueryBuilder('trade')
        .select('trade.instrument', 'instrument')
        .addSelect('COUNT(*)', 'count')
        .addSelect('SUM(trade.quantity)::text', 'quantity')
        .addSelect('SUM(trade.price * trade.quantity)::text', 'notional')
        .where('trade.executedAt >= :from AND trade.executedAt < :to', { from, to })
        .groupBy('trade.instrument')
        .orderBy('trade.instrument')
        .getRawMany();
    const first: { firstTradeAt: Date | null } | undefined = await this.trades
      .createQueryBuilder('trade')
      .select('MIN(trade.executedAt)', 'firstTradeAt')
      .getRawOne();
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      firstTradeAt: first?.firstTradeAt ? new Date(first.firstTradeAt).toISOString() : null,
      instruments: rows.map((row) => ({
        instrument: row.instrument,
        count: Number(row.count),
        quantity: row.quantity,
        notional: row.notional,
      })),
    };
  }
}
