import { ExecutedTrade } from '../orders/engine/apply-commands';
import { OutboxMessage } from './outbox-message.entity';

export const TRADE_EXECUTED = 'trade.executed';

export interface TradeExecutedEvent {
  tradeId: string;
  instrument: string;
  seq: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  price: string;
  quantity: string;
  executedAt: string;
  traceId?: string;
}

export function tradeStreamKey(instrument: string): string {
  return `trades:${instrument}`;
}

export function tradeExecutedMessage(trade: ExecutedTrade): Partial<OutboxMessage> {
  const payload: TradeExecutedEvent = {
    tradeId: trade.id,
    instrument: trade.instrument,
    seq: trade.seq,
    buyOrderId: trade.buyOrderId,
    sellOrderId: trade.sellOrderId,
    buyerId: trade.buyerId,
    sellerId: trade.sellerId,
    price: trade.price,
    quantity: trade.quantity,
    executedAt: trade.executedAt.toISOString(),
    ...(trade.traceId ? { traceId: trade.traceId } : {}),
  };
  return {
    stream: tradeStreamKey(trade.instrument),
    type: TRADE_EXECUTED,
    payload: { ...payload },
  };
}
