import { randomUUID } from 'crypto';
import { SESSION_CHANGED, SESSION_USER_HEADER } from '@/lib/session-user';
import { UPSTREAM_TIMEOUT_MS } from '@/lib/timeouts';
import { NextRequest, NextResponse } from 'next/server';
import {
  Rotation,
  SessionTokens,
  TokenPair,
  claimsOf,
  isFresh,
  clearTokens,
  readTokens,
  refreshOnce,
  refreshTokenOf,
  storeTokens,
} from './session';

const SERVICES = {
  engine: () => process.env.MATCHING_ENGINE_URL ?? 'http://localhost:3001',
  settlement: () => process.env.SETTLEMENT_URL ?? 'http://localhost:3002',
};

type Service = keyof typeof SERVICES;

export interface UpstreamResult {
  status: number;
  body: unknown;
}

function clientAddress(request: NextRequest): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
}

export function forwardedHeaders(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {
    'x-request-id': request.headers.get('x-request-id') ?? randomUUID(),
  };
  const proxyKey = process.env.FRONTEND_PROXY_KEY;
  const address = clientAddress(request);
  if (proxyKey && address) {
    headers['x-proxy-key'] = proxyKey;
    headers['x-client-ip'] = address;
  }
  return headers;
}

export async function upstream(
  request: NextRequest,
  service: Service,
  path: string,
  init: RequestInit & { headers?: Record<string, string>; timeoutMs?: number } = {},
  accessToken?: string,
): Promise<UpstreamResult> {
  const { timeoutMs = UPSTREAM_TIMEOUT_MS, ...options } = init;
  let response: Response;
  try {
    response = await fetch(`${SERVICES[service]()}${path}`, {
      ...options,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...forwardedHeaders(request),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers ?? {}),
      },
    });
  } catch {
    const name = service === 'engine' ? 'The matching engine' : 'The settlement service';
    return { status: 503, body: { message: `${name} is unavailable, try again shortly` } };
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { message: text };
  }
  return { status: response.status, body };
}

export function rotateTokens(request: NextRequest, tokens: SessionTokens): Promise<Rotation> {
  const client = request.headers.get('user-agent') ?? '';
  return refreshOnce({ ...tokens, client }, async (token, attempt) => {
    const result = await upstream(request, 'engine', '/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: token, attempt }),
    });
    if (result.status === 200) return { kind: 'rotated', tokens: result.body as TokenPair };
    if (result.status === 400 || result.status === 401) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  });
}

export async function endForgottenSessions(request: NextRequest, sessions: string[]): Promise<void> {
  await Promise.all(
    sessions.map(async (session) => {
      const refreshToken = refreshTokenOf(request, session);
      if (!refreshToken) return;
      await upstream(request, 'engine', '/auth/end-session', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
    }),
  );
}

export function isAnotherUser(request: NextRequest, accessToken: string | undefined): boolean {
  const expected = request.headers.get(SESSION_USER_HEADER);
  return Boolean(expected) && claimsOf(accessToken)?.id !== expected;
}

export function sessionChanged(): NextResponse {
  return NextResponse.json(
    { code: SESSION_CHANGED, message: 'This browser is signed in to another account now, check the page first' },
    { status: 409 },
  );
}

export async function withSession(
  request: NextRequest,
  call: (accessToken: string) => Promise<UpstreamResult>,
): Promise<NextResponse> {
  const tokens = readTokens(request);
  let rotated: TokenPair | null = null;
  let accessToken = tokens.accessToken;

  const rotate = async (): Promise<NextResponse | null> => {
    const outcome = await rotateTokens(request, {
      refreshToken: tokens.refreshToken as string,
      accessToken: tokens.accessToken,
    });
    if (outcome.kind === 'invalid') return unauthorized(tokens.session);
    if (outcome.kind === 'unavailable') return unavailable();
    rotated = outcome.tokens;
    accessToken = outcome.tokens.accessToken;
    return null;
  };

  if (!isFresh(accessToken) && tokens.refreshToken) {
    const failure = await rotate();
    if (failure) return failure;
  }
  if (!accessToken) return unauthorized(tokens.session);
  if (isAnotherUser(request, accessToken)) {
    const response = sessionChanged();
    if (rotated) storeTokens(response, rotated, tokens.session);
    return response;
  }

  let result = await call(accessToken);
  if (result.status === 401 && tokens.refreshToken && !rotated) {
    const failure = await rotate();
    if (failure) return failure;
    result = await call(accessToken);
  }
  if (result.status === 401 && rotated) {
    const response = NextResponse.json(
      { message: 'The exchange did not accept your session, try again shortly' },
      { status: 502 },
    );
    storeTokens(response, rotated, tokens.session);
    return response;
  }
  const response = NextResponse.json(result.body, { status: result.status });
  if (rotated) storeTokens(response, rotated, tokens.session);
  if (result.status === 401) clearTokens(response, [tokens.session]);
  return response;
}

export function relay(result: UpstreamResult): NextResponse {
  return NextResponse.json(result.body, { status: result.status });
}

export function unauthorized(session?: string): NextResponse {
  const response = NextResponse.json({ message: 'Sign in to continue' }, { status: 401 });
  if (session) clearTokens(response, [session]);
  return response;
}

export function unavailable(): NextResponse {
  return NextResponse.json(
    { message: 'Sign-in service is unavailable, try again shortly' },
    { status: 503 },
  );
}
