export const INSTRUMENTS = ['ABC', 'DEF', 'XYZ'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled';

export interface Order {
  id: string;
  instrument: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
  remainingQuantity: string;
  status: OrderStatus;
  createdAt: string;
}

export interface Trade {
  id: string;
  instrument: string;
  seq: number;
  price: string;
  quantity: string;
  executedAt: string;
}

export interface Balance {
  asset: string;
  balance: string;
}
