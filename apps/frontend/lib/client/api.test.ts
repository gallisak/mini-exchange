import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, SESSION_CHANGED_EVENT, api, endsSession, showingUser } from './api';

describe('a request to the exchange', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    showingUser(null);
  });

  it('says which account the page shows, so the frontend can refuse it for another one', async () => {
    const send = vi.fn(async (_path: string, _init: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', send);

    showingUser('user-a');
    await api('/api/orders');
    showingUser(null);
    await api('/api/market/book');

    expect((send.mock.calls[0][1].headers as Record<string, string>)['x-session-user']).toBe('user-a');
    expect((send.mock.calls[1][1].headers as Record<string, string>)['x-session-user']).toBeUndefined();
  });

  it('asks the page to check its session when the frontend says the account changed', async () => {
    const heard = vi.fn();
    const window = new EventTarget();
    window.addEventListener(SESSION_CHANGED_EVENT, heard);
    vi.stubGlobal('window', window);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"code":"SESSION_CHANGED","message":"Another account"}', { status: 409 })),
    );

    const failure = await api('/api/orders', { method: 'POST' }).catch((error: unknown) => error);

    expect((failure as ApiError).status).toBe(409);
    expect(heard).toHaveBeenCalledOnce();
  });

  it('tells a refusal that ends the session from any other failure', () => {
    expect(endsSession(new ApiError(401, 'Sign in to continue'))).toBe(true);
    expect(endsSession(new ApiError(503, 'Try again'))).toBe(false);
    expect(endsSession(new Error('boom'))).toBe(false);
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
