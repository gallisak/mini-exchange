import { ApiError } from './api';
import { User } from './types';

const RETRIES = 4;

const transient = (failure: unknown) =>
  !(failure instanceof ApiError) || failure.status === 0 || failure.status >= 500;

export async function checkSession(
  load: () => Promise<User | null>,
  stillWanted: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ user: User | null } | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const user = await load();
      return stillWanted() ? { user } : null;
    } catch (failure) {
      if (!stillWanted()) return null;
      if (!transient(failure) || attempt >= RETRIES) return { user: null };
      await wait(1_000 * 2 ** attempt);
      if (!stillWanted()) return null;
    }
  }
}
