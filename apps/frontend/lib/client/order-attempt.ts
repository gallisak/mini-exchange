export interface OrderDraft {
  instrument: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
}

export interface Attempt {
  key: string;
  order: string;
  draft: OrderDraft;
  unconfirmed?: boolean;
}

const fingerprint = ({ instrument, side, price, quantity }: OrderDraft) =>
  [instrument, side, price, quantity].join('|');

export function attemptFor(previous: Attempt | null, draft: OrderDraft, newKey: () => string): Attempt {
  if (previous?.unconfirmed) return previous;
  const order = fingerprint(draft);
  return previous?.order === order ? previous : { key: newKey(), order, draft };
}

export function unconfirmed(attempt: Attempt): Attempt {
  return { ...attempt, unconfirmed: true };
}

export function isUnknownOutcome(status: number): boolean {
  return status === 0 || status === 408 || status >= 500;
}
