import { SESSION_CHANGED, SESSION_HEADER } from '@/lib/session-id';

export const UNAUTHORIZED_EVENT = 'mx:unauthorized';
export const SESSION_CHANGED_EVENT = 'mx:session-changed';

const REMEMBERED_SESSION = 'mx:session';

let shownSession: string | null = null;

export function showingSession(session: string | null): void {
  shownSession = session;
  try {
    if (session) localStorage.setItem(REMEMBERED_SESSION, session);
    else localStorage.removeItem(REMEMBERED_SESSION);
  } catch {
    return;
  }
}

export function rememberedSession(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_SESSION);
  } catch {
    return null;
  }
}

export interface UnauthorizedDetail {
  startedAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: unknown,
  ) {
    super(message);
  }
}

export function endsSession(failure: unknown): boolean {
  return failure instanceof ApiError && failure.status === 401;
}

export function sessionChanged(failure: unknown): boolean {
  return failure instanceof ApiError && failure.code === SESSION_CHANGED;
}

function messageOf(body: unknown, status: number): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string' && message.length > 0 && message.length < 300) return message;
  if (status === 401) return 'Sign in to continue';
  if (status === 429) return 'Too many requests, slow down';
  if (status >= 500) return 'Service temporarily unavailable, try again shortly';
  return `Request failed (${status})`;
}

export async function api<T>(
  path: string,
  { timeoutMs, endsSessionOn401 = true, ...init }: RequestInit & { timeoutMs?: number; endsSessionOn401?: boolean } = {},
): Promise<T> {
  const startedAt = performance.now();
  const signal = timeoutMs === undefined ? init.signal : AbortSignal.timeout(timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      ...init,
      signal,
      headers: {
        'content-type': 'application/json',
        ...(shownSession ? { [SESSION_HEADER]: shownSession } : {}),
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });
    text = await response.text();
  } catch {
    if (signal?.aborted && timeoutMs !== undefined) {
      throw new ApiError(408, `The exchange did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new ApiError(0, 'Cannot reach the exchange, check your connection');
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    if (response.status === 401 && endsSessionOn401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<UnauthorizedDetail>(UNAUTHORIZED_EVENT, { detail: { startedAt } }));
    }
    const code = (body as { code?: unknown } | null)?.code;
    if (code === SESSION_CHANGED && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
    }
    throw new ApiError(response.status, messageOf(body, response.status), code);
  }
  return body as T;
}
