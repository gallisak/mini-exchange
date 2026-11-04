import { LevelChange } from '../depth';

export const MARKET_CHANNEL_PREFIX = 'market:';

export function marketChannel(instrument: string): string {
  return `${MARKET_CHANNEL_PREFIX}${instrument}`;
}

export interface BookDelta {
  instrument: string;
  seq: number;
  changes: LevelChange[];
}

export interface BookHeartbeat {
  instrument: string;
  seq: number;
}

export type MarketEvent =
  | { type: 'book_delta'; delta: BookDelta }
  | { type: 'book_heartbeat'; heartbeat: BookHeartbeat };
