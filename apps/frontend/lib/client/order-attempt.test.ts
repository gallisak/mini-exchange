import { describe, expect, it } from 'vitest';
import { attemptFor, isUnknownOutcome, unconfirmed } from './order-attempt';

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

  it('keeps the key and the order of an attempt with an unknown outcome, however the form changed', () => {
    const sent = unconfirmed(attemptFor(null, draft, newKey));

    const next = attemptFor(sent, { ...draft, price: '11.00', quantity: '3' }, newKey);

    expect(next.key).toBe(sent.key);
    expect(next.draft).toEqual(draft);
  });

  it('treats a lost connection, a timeout or a server error as an unknown outcome, and a refusal as a known one', () => {
    expect([0, 408, 500, 502, 503, 504].every(isUnknownOutcome)).toBe(true);
    expect([400, 401, 403, 409, 422, 429].some(isUnknownOutcome)).toBe(false);
  });
});
