import { endsSession, sessionChanged } from './api';

export type TokenOutcome =
  | { kind: 'token'; token: string }
  | { kind: 'signedOut' }
  | { kind: 'sessionChanged' }
  | { kind: 'cancelled' };

interface Deps {
  fetchToken: () => Promise<{ token?: unknown } | null>;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
}

const MAX_DELAY_MS = 5_000;

export async function waitForToken({ fetchToken, sleep, cancelled }: Deps): Promise<TokenOutcome> {
  for (let attempt = 0; !cancelled(); attempt += 1) {
    try {
      const body = await fetchToken();
      if (typeof body?.token === 'string' && body.token.length > 0) {
        return { kind: 'token', token: body.token };
      }
    } catch (failure) {
      if (endsSession(failure)) return { kind: 'signedOut' };
      if (sessionChanged(failure)) return { kind: 'sessionChanged' };
    }
    await sleep(Math.min(1_000 * (attempt + 1), MAX_DELAY_MS));
  }
  return { kind: 'cancelled' };
}
