import { LevelChange } from '../depth';
import { OrderSide, OrderStatus } from '../entities/order.entity';

export const MARKET_CHANNEL_PREFIX = 'market:';
export const WALLET_CHANNEL = 'wallets:updates';

export function marketChannel(instrument: string): string {
  return `${MARKET_CHANNEL_PREFIX}${instrument}`;
}

export interface BookDelta {
  instrument: string;
  seq: number;
  changes: LevelChange[];
}

export interface OrderUpdate {
  id: string;
  ownerId: string;
  instrument: string;
  side: OrderSide;
  price: string;
  quantity: string;
  remainingQuantity: string;
  status: OrderStatus;
  createdAt: string;
}

export interface BookHeartbeat {
  instrument: string;
  seq: number;
}

export type MarketEvent =
  | { type: 'book_delta'; delta: BookDelta }
  | { type: 'book_heartbeat'; heartbeat: BookHeartbeat }
  | { type: 'orders'; orders: OrderUpdate[] };

export interface WalletChanged {
  ownerId: string;
  tradeId: string;
}
