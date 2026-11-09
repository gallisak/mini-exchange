import { Order } from './entities/order.entity';

export interface Trade {
  id: string;
  instrument: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  price: string;
  quantity: string;
  executedAt: Date;
}

export interface BookSnapshot {
  bids: Order[];
  asks: Order[];
}

export interface MatchContext {
  nextTradeId: () => string;
  now: () => Date;
}

export interface MatchResult {
  trades: Trade[];
  restingOrder: Order | null;
  incomingOrder: Order;
  touchedOrders: Order[];
  updatedBids: Order[];
  updatedAsks: Order[];
}
