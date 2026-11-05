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
  if (previous?.unconfirmed && previous.draft.instrument === draft.instrument) return previous;
  const order = fingerprint(draft);
  return previous?.order === order ? previous : { key: newKey(), order, draft };
}

export function unconfirmed(attempt: Attempt): Attempt {
  return { ...attempt, unconfirmed: true };
}

export function isUnknownOutcome(status: number): boolean {
  return status === 0 || status === 408 || status >= 500;
}

export function afterFailure(attempt: Attempt, status: number): Attempt {
  return { ...attempt, unconfirmed: isUnknownOutcome(status) };
}

const storageKey = (instrument: string) => `mx:unconfirmed-order:${instrument}`;

type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function saveAttempt(
  storage: AttemptStorage | null,
  instrument: string,
  attempt: Attempt | null,
): void {
  try {
    if (attempt?.unconfirmed && attempt.draft.instrument === instrument) {
      storage?.setItem(storageKey(instrument), JSON.stringify(attempt));
    } else storage?.removeItem(storageKey(instrument));
  } catch {
    return;
  }
}

export function loadAttempt(storage: AttemptStorage | null, instrument: string): Attempt | null {
  try {
    const stored = JSON.parse(storage?.getItem(storageKey(instrument)) ?? 'null') as Partial<Attempt> | null;
    const draft = stored?.draft;
    const valid =
      typeof stored?.key === 'string' &&
      typeof stored.order === 'string' &&
      stored.unconfirmed === true &&
      draft?.instrument === instrument &&
      (draft.side === 'buy' || draft.side === 'sell') &&
      typeof draft.price === 'string' &&
      typeof draft.quantity === 'string';
    return valid ? (stored as Attempt) : null;
  } catch {
    return null;
  }
}
