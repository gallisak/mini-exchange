import { describe, expect, it } from 'vitest';
import { resyncsBook, resyncsEverything, resyncsOrders } from './types';

describe('which feeds a resync reloads', () => {
  it('reloads everything when the engine lost its subscription', () => {
    expect(resyncsBook({}, 'ABC')).toBe(true);
    expect(resyncsOrders({})).toBe(true);
    expect(resyncsEverything({})).toBe(true);
    expect(resyncsEverything(undefined)).toBe(true);
  });

  it('reloads only the book and trades of the instrument whose update was lost', () => {
    expect(resyncsBook({ instrument: 'ABC' }, 'ABC')).toBe(true);
    expect(resyncsBook({ instrument: 'ABC' }, 'DEF')).toBe(false);
    expect(resyncsOrders({ instrument: 'ABC' })).toBe(false);
    expect(resyncsEverything({ instrument: 'ABC' })).toBe(false);
  });

  it('reloads only the orders when an order update was lost', () => {
    expect(resyncsOrders({ orders: true })).toBe(true);
    expect(resyncsBook({ orders: true }, 'ABC')).toBe(false);
    expect(resyncsEverything({ orders: true })).toBe(false);
  });
});
