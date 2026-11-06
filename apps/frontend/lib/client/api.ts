export const UNAUTHORIZED_EVENT = 'mx:unauthorized';

export interface UnauthorizedDetail {
  startedAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
  { timeoutMs, ...init }: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const startedAt = performance.now();
  const signal = timeoutMs === undefined ? init.signal : AbortSignal.timeout(timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      ...init,
      signal,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<UnauthorizedDetail>(UNAUTHORIZED_EVENT, { detail: { startedAt } }));
    }
    throw new ApiError(response.status, messageOf(body, response.status));
  }
  return body as T;
}
