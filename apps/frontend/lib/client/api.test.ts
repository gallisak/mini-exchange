import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

describe('a request to the exchange', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives up on an answer that never comes when it was given a time limit', async () => {
    vi.stubGlobal(
      'fetch',
      (_: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const failure = await api('/api/ops', { timeoutMs: 20 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(408);
  });

  it('gives up on a body that stops halfway', async () => {
    vi.stubGlobal('fetch', (_: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      }),
    );

    const failure = await api('/api/ops', { timeoutMs: 20 }).catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(408);
  });

  it('ends the session on a 401, except for a request whose 401 means something else, such as a wrong password', async () => {
    const events: string[] = [];
    vi.stubGlobal('window', {
      dispatchEvent: (event: Event) => events.push(event.type),
    });
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 401, text: async () => '{}' }));

    await api('/api/auth/login', { method: 'POST', endsSessionOn401: false }).catch(() => undefined);
    expect(events).toEqual([]);

    await api('/api/orders').catch(() => undefined);
    expect(events).toEqual(['mx:unauthorized']);
  });
});
