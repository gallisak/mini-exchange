import { Attempt, AttemptStorage, loadAttempt, replaceAttempt, saveAttempt } from './order-attempt';

export interface AttemptStore {
  get(owner: string, instrument: string): Attempt | null;
  save(owner: string, instrument: string, attempt: Attempt | null): void;
  replace(owner: string, instrument: string, sent: Attempt, next: Attempt | null): boolean;
  subscribe(listener: () => void): () => void;
}

function quietly(write: () => void): void {
  try {
    write();
  } catch {
    return;
  }
}

export function createAttemptStore(backing: () => AttemptStorage | null): AttemptStore {
  const items = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const shown = new Map<string, { version: number; attempt: Attempt | null }>();
  let version = 0;

  const changed = () => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  const storage: AttemptStorage = {
    getItem: (key) => {
      if (!items.has(key)) {
        let stored: string | null = null;
        try {
          stored = backing()?.getItem(key) ?? null;
        } catch {
          stored = null;
        }
        items.set(key, stored);
      }
      return items.get(key) ?? null;
    },
    setItem: (key, value) => {
      items.set(key, value);
      quietly(() => backing()?.setItem(key, value));
      changed();
    },
    removeItem: (key) => {
      items.set(key, null);
      quietly(() => backing()?.removeItem(key));
      changed();
    },
  };

  return {
    get(owner, instrument) {
      const scope = `${owner}:${instrument}`;
      const cached = shown.get(scope);
      if (cached?.version === version) return cached.attempt;
      const attempt = loadAttempt(storage, owner, instrument);
      const same = cached && JSON.stringify(cached.attempt) === JSON.stringify(attempt);
      const result = same ? cached.attempt : attempt;
      shown.set(scope, { version, attempt: result });
      return result;
    },
    save: (owner, instrument, attempt) => saveAttempt(storage, owner, instrument, attempt),
    replace: (owner, instrument, sent, next) => replaceAttempt(storage, owner, instrument, sent, next),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const orderAttempts = createAttemptStore(() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
});
