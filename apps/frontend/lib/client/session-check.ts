import { ApiError } from './api';

export type SessionCheck<T> = { answer: T } | { failed: true } | null;

const transient = (failure: unknown) =>
  !(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500;

export async function checkSession<T>(
  load: () => Promise<T>,
  stillWanted: () => boolean,
  retries: number,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SessionCheck<T>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await load();
      return stillWanted() ? { answer } : null;
    } catch (failure) {
      if (!stillWanted()) return null;
      if (!transient(failure) || attempt >= retries) return { failed: true };
      await wait(1_000 * 2 ** attempt);
      if (!stillWanted()) return null;
    }
  }
}
