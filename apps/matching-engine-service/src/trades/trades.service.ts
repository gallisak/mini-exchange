import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TradeRecord } from '../orders/entities/trade-record.entity';
import { InstrumentState } from '../orders/entities/instrument-state.entity';
import { commandStreamKey, streamTimestamp } from '../orders/engine/order-command';
import { INSTRUMENTS } from '../common/instruments';
import { RedisService } from '../redis/redis.service';
import { withTimeout } from '../common/with-timeout';
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
  pendingSince: string | null;
  instruments: InstrumentTradeTotals[];
}

const PENDING_TIMEOUT_MS = 2_000;

@Injectable()
export class TradesService {
  constructor(
    @InjectRepository(TradeRecord) private readonly trades: Repository<TradeRecord>,
    @InjectRepository(InstrumentState) private readonly states: Repository<InstrumentState>,
    private readonly redis: RedisService,
  ) {}

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
      pendingSince: await this.pendingSince(),
      instruments: rows.map((row) => ({
        instrument: row.instrument,
        count: Number(row.count),
        quantity: row.quantity,
        notional: row.notional,
      })),
    };
  }

  private async pendingSince(): Promise<string | null> {
    const states = await this.states.find({ select: { instrument: true, lastCommandId: true } });
    const applied = new Map(states.map((state) => [state.instrument, state.lastCommandId]));
    const oldest = await Promise.all(
      INSTRUMENTS.map(async (instrument) => {
        const next = (await withTimeout(
          this.redis.client.xrange(
            commandStreamKey(instrument),
            `(${applied.get(instrument) ?? '0-0'}`,
            '+',
            'COUNT',
            1,
          ),
          PENDING_TIMEOUT_MS,
          'Redis',
        )) as [string, string[]][];
        return next.length > 0 ? streamTimestamp(next[0][0]).getTime() : null;
      }),
    );
    const [unpublished]: { oldest: Date | null }[] = await this.trades.query(
      `SELECT MIN(("payload"->>'executedAt')::timestamptz) AS "oldest" FROM "outbox" WHERE "publishedAt" IS NULL`,
    );
    oldest.push(unpublished?.oldest ? new Date(unpublished.oldest).getTime() : null);
    const known = oldest.filter((time): time is number => time !== null);
    return known.length > 0 ? new Date(Math.min(...known)).toISOString() : null;
  }
}
