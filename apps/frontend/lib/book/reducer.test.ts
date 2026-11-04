import { describe, expect, it } from 'vitest';
import {
  BookState,
  Delta,
  SILENCE_LIMIT_MS,
  Snapshot,
  bookReducer,
  initialBook,
  needsSnapshot,
} from './reducer';

const snapshot = (seq: number, overrides: Partial<Snapshot> = {}): Snapshot => ({
  instrument: 'ABC',
  seq,
  bids: [{ price: '99.00', quantity: '1.00000000', orders: 1 }],
  asks: [{ price: '101.00', quantity: '2.00000000', orders: 1 }],
  ...overrides,
});

const delta = (seq: number, changes: Delta['changes']): Delta => ({ instrument: 'ABC', seq, changes });

const ask = (price: string, quantity: string, orders = 1) => ({
  side: 'sell' as const,
  price,
  quantity,
  orders,
});
const bid = (price: string, quantity: string, orders = 1) => ({
  side: 'buy' as const,
  price,
  quantity,
  orders,
});

function live(seq = 5): BookState {
  const connected = bookReducer(initialBook('ABC'), { type: 'connected', at: 0 });
  return bookReducer(connected, { type: 'snapshot', snapshot: snapshot(seq), at: 0 });
}

describe('order book resync', () => {
  it('goes live on the first snapshot', () => {
    const state = live(5);

    expect(state.status).toBe('live');
    expect(state.seq).toBe(5);
    expect(state.asks).toEqual([{ price: '101.00', quantity: '2.00000000', orders: 1 }]);
  });

  it('applies consecutive deltas, keeps levels in book order and drops emptied levels', () => {
    let state = live(5);

    state = bookReducer(state, {
      type: 'delta',
      delta: delta(6, [ask('100.50', '1.00000000'), bid('99.50', '3.00000000')]),
      at: 1,
    });
    state = bookReducer(state, { type: 'delta', delta: delta(7, [ask('101.00', '0', 0)]), at: 2 });

    expect(state.status).toBe('live');
    expect(state.seq).toBe(7);
    expect(state.asks.map((level) => level.price)).toEqual(['100.50']);
    expect(state.bids.map((level) => level.price)).toEqual(['99.50', '99.00']);
  });

  it('orders prices by value, not by text', () => {
    let state = live(1);

    state = bookReducer(state, {
      type: 'delta',
      delta: delta(2, [ask('1000.00', '1'), ask('200.00', '1'), bid('9.00', '1'), bid('10.00', '1')]),
      at: 1,
    });

    expect(state.asks.map((level) => level.price)).toEqual(['101.00', '200.00', '1000.00']);
    expect(state.bids.map((level) => level.price)).toEqual(['99.00', '10.00', '9.00']);
  });

  it('ignores a delta it has already seen', () => {
    const state = live(5);

    const next = bookReducer(state, { type: 'delta', delta: delta(5, [ask('1.00', '9')]), at: 1 });

    expect(next.asks).toEqual(state.asks);
    expect(next.status).toBe('live');
  });

  it('marks the book stale and asks for a snapshot when a sequence number is skipped', () => {
    const state = bookReducer(live(5), { type: 'delta', delta: delta(7, [ask('1.00', '9')]), at: 1 });

    expect(state.status).toBe('stale');
    expect(state.seq).toBe(5);
    expect(state.asks.map((level) => level.price)).toEqual(['101.00']);
    expect(needsSnapshot(state)).toBe(true);
  });

  it('asks only once until the requested snapshot arrives, then goes live again', () => {
    let state = bookReducer(live(5), { type: 'delta', delta: delta(7, [ask('1.00', '9')]), at: 1 });
    state = bookReducer(state, { type: 'snapshotRequested', at: 2 });

    expect(needsSnapshot(state)).toBe(false);

    state = bookReducer(state, { type: 'delta', delta: delta(9, [ask('2.00', '1')]), at: 3 });
    state = bookReducer(state, { type: 'snapshot', snapshot: snapshot(8), at: 4 });

    expect(state.status).toBe('live');
    expect(state.seq).toBe(9);
    expect(state.asks.map((level) => level.price)).toEqual(['2.00', '101.00']);
  });

  it('buffers deltas that arrive before the snapshot and applies only the newer ones', () => {
    let state = bookReducer(initialBook('ABC'), { type: 'connected', at: 0 });
    state = bookReducer(state, { type: 'delta', delta: delta(4, [ask('50.00', '1')]), at: 1 });
    state = bookReducer(state, { type: 'delta', delta: delta(6, [ask('60.00', '1')]), at: 1 });
    state = bookReducer(state, { type: 'delta', delta: delta(5, [ask('55.00', '1')]), at: 1 });

    state = bookReducer(state, { type: 'snapshot', snapshot: snapshot(4), at: 2 });

    expect(state.status).toBe('live');
    expect(state.seq).toBe(6);
    expect(state.asks.map((level) => level.price)).toEqual(['55.00', '60.00', '101.00']);
  });

  it('goes stale if the buffered deltas do not continue from the snapshot', () => {
    let state = bookReducer(initialBook('ABC'), { type: 'connected', at: 0 });
    state = bookReducer(state, { type: 'delta', delta: delta(7, [ask('70.00', '1')]), at: 1 });

    state = bookReducer(state, { type: 'snapshot', snapshot: snapshot(5), at: 2 });

    expect(state.status).toBe('stale');
    expect(needsSnapshot(state)).toBe(true);
  });

  it('notices a lost last delta from a heartbeat that is ahead of it', () => {
    const state = bookReducer(live(5), { type: 'heartbeat', seq: 6, at: 1 });

    expect(state.status).toBe('stale');
    expect(needsSnapshot(state)).toBe(true);
  });

  it('stays live on a heartbeat that matches its sequence number', () => {
    expect(bookReducer(live(5), { type: 'heartbeat', seq: 5, at: 1 }).status).toBe('live');
  });

  it('goes stale when it has heard nothing for too long', () => {
    const quiet = bookReducer(live(5), { type: 'tick', at: SILENCE_LIMIT_MS + 1 });
    const recent = bookReducer(live(5), { type: 'tick', at: SILENCE_LIMIT_MS - 1 });

    expect(quiet.status).toBe('stale');
    expect(recent.status).toBe('live');
  });

  it('shows reconnecting on a lost connection and asks for a fresh snapshot once back', () => {
    let state = bookReducer(live(5), { type: 'disconnected' });
    expect(state.status).toBe('reconnecting');

    state = bookReducer(state, { type: 'connected', at: 10 });
    state = bookReducer(state, { type: 'delta', delta: delta(9, [ask('9.00', '1')]), at: 11 });
    expect(state.status).toBe('reconnecting');
    expect(state.seq).toBe(5);

    state = bookReducer(state, { type: 'snapshot', snapshot: snapshot(8), at: 12 });
    expect(state.status).toBe('live');
    expect(state.seq).toBe(9);
  });

  it('ignores messages for another instrument', () => {
    const state = live(5);

    expect(
      bookReducer(state, { type: 'snapshot', snapshot: snapshot(1, { instrument: 'DEF' }), at: 1 }),
    ).toBe(state);
    expect(
      bookReducer(state, { type: 'delta', delta: { ...delta(6, []), instrument: 'DEF' }, at: 1 }),
    ).toBe(state);
  });
});
