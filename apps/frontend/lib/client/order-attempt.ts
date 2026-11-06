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
  sends?: number;
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

export function sentAgain(attempt: Attempt, stored: Attempt | null): Attempt {
  const sends = Math.max(attempt.sends ?? 0, stored?.key === attempt.key ? (stored.sends ?? 0) : 0) + 1;
  return { ...attempt, unconfirmed: true, sends };
}

export function isUnknownOutcome(status: number): boolean {
  return status === 0 || status === 408 || status >= 500;
}

export function afterFailure(attempt: Attempt, status: number, resent: boolean): Attempt {
  return { ...attempt, unconfirmed: resent || isUnknownOutcome(status) };
}

const storageKey = (owner: string, instrument: string) => `mx:unconfirmed-order:${owner}:${instrument}`;

export type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function saveAttempt(
  storage: AttemptStorage | null,
  owner: string,
  instrument: string,
  attempt: Attempt | null,
): void {
  try {
    if (attempt?.unconfirmed && attempt.draft.instrument === instrument) {
      storage?.setItem(storageKey(owner, instrument), JSON.stringify(attempt));
    } else storage?.removeItem(storageKey(owner, instrument));
  } catch {
    return;
  }
}

export function replaceAttempt(
  storage: AttemptStorage | null,
  owner: string,
  instrument: string,
  sent: Attempt,
  attempt: Attempt | null,
): boolean {
  const stored = loadAttempt(storage, owner, instrument);
  if (stored?.key !== sent.key || (stored.sends ?? 0) !== (sent.sends ?? 0)) return false;
  saveAttempt(storage, owner, instrument, attempt);
  return true;
}

export function loadAttempt(
  storage: AttemptStorage | null,
  owner: string,
  instrument: string,
): Attempt | null {
  try {
    const stored = JSON.parse(storage?.getItem(storageKey(owner, instrument)) ?? 'null') as Partial<Attempt> | null;
    const draft = stored?.draft;
    const valid =
      typeof stored?.key === 'string' &&
      typeof stored.order === 'string' &&
      stored.unconfirmed === true &&
      draft?.instrument === instrument &&
      (draft.side === 'buy' || draft.side === 'sell') &&
      typeof draft.price === 'string' &&
      typeof draft.quantity === 'string' &&
      (stored.sends === undefined || Number.isSafeInteger(stored.sends));
    return valid ? (stored as Attempt) : null;
  } catch {
    return null;
  }
}
