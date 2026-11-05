export interface OrderDraft {
  instrument: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
}

export interface Attempt {
  key: string;
  order: string;
}

const fingerprint = ({ instrument, side, price, quantity }: OrderDraft) =>
  [instrument, side, price, quantity].join('|');

export function attemptFor(previous: Attempt | null, draft: OrderDraft, newKey: () => string): Attempt {
  const order = fingerprint(draft);
  return previous?.order === order ? previous : { key: newKey(), order };
}
