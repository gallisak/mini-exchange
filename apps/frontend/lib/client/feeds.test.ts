import { describe, expect, it } from 'vitest';
import { laterOrder, mergeOrders, mergeTrades, newestSeq, skipsTrades } from './feeds';
import { Order, Trade } from './types';

const trade = (seq: number): Trade => ({
  id: `t${seq}`,
  instrument: 'ABC',
  seq,
  price: '100.00',
  quantity: '1.00000000',
  executedAt: '2026-11-05T10:00:00.000Z',
});

const order = (overrides: Partial<Order>): Order => ({
  id: 'o1',
  instrument: 'ABC',
  side: 'buy',
  price: '100.00',
  quantity: '2.00000000',
  remainingQuantity: '2.00000000',
  status: 'open',
  createdAt: '2026-11-05T10:00:00.000Z',
  ...overrides,
});

describe('recent trades feed', () => {
  it('keeps trades that arrived while the list was loading', () => {
    const loaded = [trade(3), trade(2), trade(1)];
    const arrivedMeanwhile = [trade(3), trade(4)];

    expect(mergeTrades(loaded, arrivedMeanwhile, 50).map((t) => t.seq)).toEqual([4, 3, 2, 1]);
  });

  it('keeps only the newest trades', () => {
    expect(mergeTrades([trade(1), trade(2)], [trade(3)], 2).map((t) => t.seq)).toEqual([3, 2]);
  });

  it('notices a trade that skips a sequence number', () => {
    const newest = newestSeq([trade(5), trade(4)]);

    expect(skipsTrades(newest, trade(6))).toBe(false);
    expect(skipsTrades(newest, trade(5))).toBe(false);
    expect(skipsTrades(newest, trade(8))).toBe(true);
    expect(skipsTrades(null, trade(8))).toBe(false);
  });
});

describe('own orders list', () => {
  it('does not let an older reload undo a newer live update', () => {
    const live = order({ remainingQuantity: '0.00000000', status: 'filled' });
    const reloaded = order({ remainingQuantity: '2.00000000', status: 'open' });

    expect(mergeOrders([live], [reloaded])).toEqual([live]);
  });

  it('takes the more filled version of a partially filled order', () => {
    const earlier = order({ remainingQuantity: '1.50000000', status: 'partially_filled' });
    const later = order({ remainingQuantity: '0.5', status: 'partially_filled' });

    expect(laterOrder(earlier, later)).toBe(later);
    expect(laterOrder(later, earlier)).toBe(later);
  });

  it('treats a cancellation as final', () => {
    const partial = order({ remainingQuantity: '1.00000000', status: 'partially_filled' });
    const cancelled = order({ remainingQuantity: '0.00000000', status: 'cancelled' });

    expect(laterOrder(partial, cancelled)).toBe(cancelled);
    expect(laterOrder(cancelled, partial)).toBe(cancelled);
  });

  it('adds new orders and keeps the newest first', () => {
    const older = order({ id: 'a', createdAt: '2026-11-05T09:00:00.000Z' });
    const newer = order({ id: 'b', createdAt: '2026-11-05T11:00:00.000Z' });

    expect(mergeOrders([older], [newer]).map((o) => o.id)).toEqual(['b', 'a']);
  });
});
