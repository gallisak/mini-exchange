export const UNAUTHORIZED_EVENT = 'mx:unauthorized';

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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the exchange, check your connection');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(response.status, messageOf(body, response.status));
  }
  return body as T;
}
