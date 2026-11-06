import { describe, expect, it, vi } from 'vitest';
import { createAttemptStore } from './attempt-store';
import { afterFailure, attemptFor, sentAgain } from './order-attempt';

const draft = { instrument: 'ABC', side: 'buy' as const, price: '10.00', quantity: '1' };

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const full = {
  getItem: () => null,
  setItem: () => {
    throw new DOMException('The quota has been exceeded', 'QuotaExceededError');
  },
  removeItem: () => undefined,
};

describe('the order attempts every form on the page shares', () => {
  it('keeps an order with an unknown outcome even when the browser cannot store it', () => {
    const store = createAttemptStore(() => full);
    const sent = sentAgain(attemptFor(null, draft, () => 'k1'), null);
    store.save('alice', 'ABC', sent);

    expect(store.replace('alice', 'ABC', sent, afterFailure(sent, 503, false))).toBe(true);

    expect(store.get('alice', 'ABC')).toMatchObject({ key: 'k1', unconfirmed: true });
    expect(attemptFor(store.get('alice', 'ABC'), draft, () => 'k2').key).toBe('k1');
  });

  it('brings an order with an unknown outcome back after a page reload', () => {
    const storage = memoryStorage();
    const sent = sentAgain(attemptFor(null, draft, () => 'k1'), null);
    createAttemptStore(() => storage).save('alice', 'ABC', sent);

    const reloaded = createAttemptStore(() => storage);

    expect(reloaded.get('alice', 'ABC')).toEqual(sent);
    expect(reloaded.get('bob', 'ABC')).toBeNull();
  });

  it('shows a form mounted while the order was on its way the answer that came back', () => {
    const store = createAttemptStore(() => memoryStorage());
    const listener = vi.fn();
    const sent = sentAgain(attemptFor(null, draft, () => 'k1'), null);
    store.save('alice', 'ABC', sent);
    const stop = store.subscribe(listener);
    const seenByNewForm = store.get('alice', 'ABC');

    store.replace('alice', 'ABC', sent, null);

    expect(seenByNewForm?.key).toBe('k1');
    expect(listener).toHaveBeenCalled();
    expect(store.get('alice', 'ABC')).toBeNull();
    stop();
  });

  it('gives the same object until something changes, as React requires of a snapshot', () => {
    const store = createAttemptStore(() => memoryStorage());
    store.save('alice', 'ABC', sentAgain(attemptFor(null, draft, () => 'k1'), null));

    expect(store.get('alice', 'ABC')).toBe(store.get('alice', 'ABC'));
  });

  it('does not let an earlier send settle an attempt that was sent again since', () => {
    const store = createAttemptStore(() => memoryStorage());
    const original = sentAgain(attemptFor(null, draft, () => 'k1'), null);
    store.save('alice', 'ABC', original);
    const resend = sentAgain(original, store.get('alice', 'ABC'));
    store.save('alice', 'ABC', resend);

    expect(store.replace('alice', 'ABC', original, null)).toBe(false);
    expect(store.get('alice', 'ABC')).toMatchObject({ key: 'k1', sends: 2 });
  });
});
