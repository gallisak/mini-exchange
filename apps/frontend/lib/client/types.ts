export const INSTRUMENTS: readonly string[] = (process.env.NEXT_PUBLIC_INSTRUMENTS ?? 'ABC,DEF,XYZ')
  .split(',')
  .map((instrument) => instrument.trim())
  .filter((instrument) => instrument.length > 0);
export type Instrument = string;

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

export interface ResyncScope {
  instrument?: string;
  orders?: boolean;
}

export const resyncsBook = (scope: ResyncScope | undefined, instrument: string) =>
  !scope?.orders && (scope?.instrument === undefined || scope.instrument === instrument);

export const resyncsOrders = (scope: ResyncScope | undefined) => scope?.instrument === undefined;

export const resyncsEverything = (scope: ResyncScope | undefined) =>
  scope?.instrument === undefined && !scope?.orders;

export interface Balance {
  asset: string;
  balance: string;
}
