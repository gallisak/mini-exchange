import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  Rotation,
  SessionTokens,
  TokenPair,
  clearTokens,
  isFresh,
  readTokens,
  refreshOnce,
  storeTokens,
} from './session';

const SERVICES = {
  engine: () => process.env.MATCHING_ENGINE_URL ?? 'http://localhost:3001',
  settlement: () => process.env.SETTLEMENT_URL ?? 'http://localhost:3002',
};
const UPSTREAM_TIMEOUT_MS = 10_000;

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
  init: RequestInit & { headers?: Record<string, string> } = {},
  accessToken?: string,
): Promise<UpstreamResult> {
  let response: Response;
  try {
    response = await fetch(`${SERVICES[service]()}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...forwardedHeaders(request),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(init.headers ?? {}),
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
  const client = `${clientAddress(request) ?? ''} ${request.headers.get('user-agent') ?? ''}`;
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
    if (outcome.kind === 'invalid') return unauthorized();
    if (outcome.kind === 'unavailable') return unavailable();
    rotated = outcome.tokens;
    accessToken = outcome.tokens.accessToken;
    return null;
  };

  if (!isFresh(accessToken) && tokens.refreshToken) {
    const failure = await rotate();
    if (failure) return failure;
  }
  if (!accessToken) return unauthorized();

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
    storeTokens(response, rotated);
    return response;
  }
  const response = NextResponse.json(result.body, { status: result.status });
  if (rotated) storeTokens(response, rotated);
  if (result.status === 401) clearTokens(response);
  return response;
}

export function relay(result: UpstreamResult): NextResponse {
  return NextResponse.json(result.body, { status: result.status });
}

export function unauthorized(): NextResponse {
  const response = NextResponse.json({ message: 'Sign in to continue' }, { status: 401 });
  clearTokens(response);
  return response;
}

export function unavailable(): NextResponse {
  return NextResponse.json(
    { message: 'Sign-in service is unavailable, try again shortly' },
    { status: 503 },
  );
}
