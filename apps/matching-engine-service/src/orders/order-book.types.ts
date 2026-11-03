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
  bids: Order[]; // сортовані: ціна спадає, за рівної ціни — час зростає
  asks: Order[]; // сортовані: ціна зростає, за рівної ціни — час зростає
}

export interface MatchContext {
  nextTradeId: () => string;
  now: () => Date;
}

export interface MatchResult {
  trades: Trade[];
  restingOrder: Order | null; // залишок заявки, що лягає в книгу (якщо є)
  incomingOrder: Order;
  touchedOrders: Order[];
  updatedBids: Order[];
  updatedAsks: Order[];
}
