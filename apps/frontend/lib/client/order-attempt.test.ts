import { describe, expect, it } from 'vitest';
import { attemptFor } from './order-attempt';

const draft = { instrument: 'ABC', side: 'buy' as const, price: '10.00', quantity: '1' };
let n = 0;
const newKey = () => `key-${++n}`;

describe('Idempotency-Key of an order attempt', () => {
  it('reuses the key when the same order is sent again after a failure', () => {
    const first = attemptFor(null, draft, newKey);

    expect(attemptFor(first, { ...draft }, newKey)).toBe(first);
  });

  it('takes a new key once anything about the order changed, the instrument included', () => {
    const first = attemptFor(null, draft, newKey);

    for (const change of [{ instrument: 'DEF' }, { side: 'sell' as const }, { price: '11.00' }, { quantity: '2' }]) {
      expect(attemptFor(first, { ...draft, ...change }, newKey).key).not.toBe(first.key);
    }
  });
});
