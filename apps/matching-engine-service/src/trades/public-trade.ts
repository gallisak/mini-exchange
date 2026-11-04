import { TradeRecord } from '../orders/entities/trade-record.entity';

export interface PublicTrade {
  id: string;
  instrument: string;
  seq: number;
  price: string;
  quantity: string;
  executedAt: string;
}

type TradeFields = Pick<TradeRecord, 'id' | 'instrument' | 'seq' | 'price' | 'quantity' | 'executedAt'>;

export function publicTrade(trade: TradeFields): PublicTrade {
  return {
    id: trade.id,
    instrument: trade.instrument,
    seq: Number(trade.seq),
    price: trade.price,
    quantity: trade.quantity,
    executedAt: trade.executedAt.toISOString(),
  };
}
