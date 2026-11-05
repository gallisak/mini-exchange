export type TokenOutcome = { kind: 'token'; token: string } | { kind: 'signedOut' } | { kind: 'cancelled' };

interface Deps {
  fetchToken: () => Promise<Response | null>;
  sleep: (ms: number) => Promise<void>;
  cancelled: () => boolean;
}

const MAX_DELAY_MS = 5_000;

export async function waitForToken({ fetchToken, sleep, cancelled }: Deps): Promise<TokenOutcome> {
  for (let attempt = 0; !cancelled(); attempt += 1) {
    const response = await fetchToken().catch(() => null);
    if (response?.status === 401) return { kind: 'signedOut' };
    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
      if (typeof body?.token === 'string' && body.token.length > 0) {
        return { kind: 'token', token: body.token };
      }
    }
    await sleep(Math.min(1_000 * (attempt + 1), MAX_DELAY_MS));
  }
  return { kind: 'cancelled' };
}
