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
  requestedAt: number | null;
  lastHeardAt: number;
  silenceLimitMs: number;
  resyncs: number;
}

export type BookAction =
  | { type: 'connected'; at: number }
  | { type: 'disconnected' }
  | { type: 'snapshotRequested'; at: number }
  | { type: 'snapshotDelayed'; retryAfterMs: number; at: number }
  | { type: 'snapshot'; snapshot: Snapshot; at: number }
  | { type: 'delta'; delta: Delta; at: number }
  | { type: 'heartbeat'; seq: number; intervalMs?: number; at: number }
  | { type: 'resync' }
  | { type: 'tick'; at: number };

export const SILENCE_LIMIT_MS = 7_000;
export const SNAPSHOT_TIMEOUT_MS = 5_000;
const MISSED_HEARTBEATS = 3;
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
    requestedAt: null,
    lastHeardAt: at,
    silenceLimitMs: SILENCE_LIMIT_MS,
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
  return { ...state, status: 'stale', awaitingSnapshot: false, requestedAt: null };
}

function silenceLimitFor(intervalMs: number | undefined): number {
  return typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.max(SILENCE_LIMIT_MS, intervalMs * MISSED_HEARTBEATS)
    : SILENCE_LIMIT_MS;
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
        requestedAt: action.at,
        pending: [],
        lastHeardAt: action.at,
      };

    case 'disconnected':
      return { ...state, status: 'reconnecting', awaitingSnapshot: false, requestedAt: null };

    case 'snapshotRequested':
      return {
        ...state,
        awaitingSnapshot: true,
        requestedAt: action.at,
        resyncs: state.resyncs + 1,
        lastHeardAt: action.at,
      };

    case 'snapshotDelayed':
      return state.awaitingSnapshot
        ? { ...state, requestedAt: action.at + Math.max(0, action.retryAfterMs) }
        : state;

    case 'snapshot': {
      if (action.snapshot.instrument !== state.instrument) return state;
      if (state.seq !== null && action.snapshot.seq < state.seq) return state;
      let next: BookState = {
        ...state,
        status: 'live',
        seq: action.snapshot.seq,
        bids: sortLevels(action.snapshot.bids, 'buy'),
        asks: sortLevels(action.snapshot.asks, 'sell'),
        pending: [],
        awaitingSnapshot: false,
        requestedAt: null,
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
      const heard = {
        ...state,
        lastHeardAt: action.at,
        silenceLimitMs: silenceLimitFor(action.intervalMs),
      };
      return state.status === 'live' && state.seq !== null && action.seq > state.seq
        ? stale(heard)
        : heard;
    }

    case 'resync':
      return state.status === 'live' ? stale(state) : state;

    case 'tick':
      if (
        state.awaitingSnapshot &&
        state.requestedAt !== null &&
        action.at - state.requestedAt > SNAPSHOT_TIMEOUT_MS
      ) {
        return stale(state);
      }
      return state.status === 'live' && action.at - state.lastHeardAt > state.silenceLimitMs
        ? stale(state)
        : state;
  }
}
