export type Side = 'buy' | 'sell';
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'stale';

export interface Level {
  price: string;
  quantity: string;
  orders: number;
}

export interface Snapshot {
  instrument: string;
  seq: number;
  bids: Level[];
  asks: Level[];
}

export interface Delta {
  instrument: string;
  seq: number;
  changes: (Level & { side: Side })[];
}

export interface BookState {
  instrument: string;
  status: ConnectionStatus;
  seq: number | null;
  bids: Level[];
  asks: Level[];
  pending: Delta[];
  awaitingSnapshot: boolean;
  lastHeardAt: number;
  resyncs: number;
}

export type BookAction =
  | { type: 'connected'; at: number }
  | { type: 'disconnected' }
  | { type: 'snapshotRequested'; at: number }
  | { type: 'snapshot'; snapshot: Snapshot; at: number }
  | { type: 'delta'; delta: Delta; at: number }
  | { type: 'heartbeat'; seq: number; at: number }
  | { type: 'tick'; at: number };

export const SILENCE_LIMIT_MS = 7_000;
const PENDING_LIMIT = 1_000;

export function initialBook(instrument: string, at = 0): BookState {
  return {
    instrument,
    status: 'connecting',
    seq: null,
    bids: [],
    asks: [],
    pending: [],
    awaitingSnapshot: false,
    lastHeardAt: at,
    resyncs: 0,
  };
}

const priceUnits = (price: string) => {
  const [whole, fraction = ''] = price.split('.');
  return BigInt(whole + fraction.padEnd(2, '0'));
};

function sortLevels(levels: Level[], side: Side): Level[] {
  return [...levels].sort((a, b) => {
    const difference = priceUnits(a.price) - priceUnits(b.price);
    const ascending = difference < 0n ? -1 : difference > 0n ? 1 : 0;
    return side === 'buy' ? -ascending : ascending;
  });
}

function applyChanges(state: BookState, delta: Delta): BookState {
  const sides = {
    buy: new Map(state.bids.map((level) => [level.price, level])),
    sell: new Map(state.asks.map((level) => [level.price, level])),
  };
  for (const { side, ...level } of delta.changes) {
    if (level.orders === 0) sides[side].delete(level.price);
    else sides[side].set(level.price, level);
  }
  return {
    ...state,
    seq: delta.seq,
    bids: sortLevels([...sides.buy.values()], 'buy'),
    asks: sortLevels([...sides.sell.values()], 'sell'),
  };
}

function stale(state: BookState): BookState {
  return { ...state, status: 'stale', awaitingSnapshot: false };
}

export function needsSnapshot(state: BookState): boolean {
  return state.status === 'stale' && !state.awaitingSnapshot;
}

export function bookReducer(state: BookState, action: BookAction): BookState {
  switch (action.type) {
    case 'connected':
      return {
        ...state,
        status: state.seq === null ? 'connecting' : 'reconnecting',
        awaitingSnapshot: true,
        pending: [],
        lastHeardAt: action.at,
      };

    case 'disconnected':
      return { ...state, status: 'reconnecting', awaitingSnapshot: false };

    case 'snapshotRequested':
      return { ...state, awaitingSnapshot: true, resyncs: state.resyncs + 1, lastHeardAt: action.at };

    case 'snapshot': {
      if (action.snapshot.instrument !== state.instrument) return state;
      let next: BookState = {
        ...state,
        status: 'live',
        seq: action.snapshot.seq,
        bids: sortLevels(action.snapshot.bids, 'buy'),
        asks: sortLevels(action.snapshot.asks, 'sell'),
        pending: [],
        awaitingSnapshot: false,
        lastHeardAt: action.at,
      };
      const buffered = [...state.pending]
        .filter((delta) => delta.seq > action.snapshot.seq)
        .sort((a, b) => a.seq - b.seq);
      for (const delta of buffered) {
        if (delta.seq !== (next.seq ?? 0) + 1) return stale(next);
        next = applyChanges(next, delta);
      }
      return next;
    }

    case 'delta': {
      const { delta } = action;
      if (delta.instrument !== state.instrument) return state;
      const heard = { ...state, lastHeardAt: action.at };
      if (state.seq === null || state.awaitingSnapshot || state.status === 'stale') {
        return { ...heard, pending: [...state.pending, delta].slice(-PENDING_LIMIT) };
      }
      if (delta.seq <= state.seq) return heard;
      if (delta.seq !== state.seq + 1) return stale({ ...heard, pending: [delta] });
      return { ...applyChanges(heard, delta), status: 'live' };
    }

    case 'heartbeat': {
      const heard = { ...state, lastHeardAt: action.at };
      if (state.status === 'live' && state.seq !== null && action.seq > state.seq) {
        return stale(heard);
      }
      return heard;
    }

    case 'tick':
      return state.status === 'live' && action.at - state.lastHeardAt > SILENCE_LIMIT_MS
        ? stale(state)
        : state;
  }
}
