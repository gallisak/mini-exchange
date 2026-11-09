import { randomUUID } from 'crypto';
import { SESSION_CHANGED, SESSION_ENDED } from '@/lib/session-id';
import { END_SESSION_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS } from '@/lib/timeouts';
import { NextRequest, NextResponse } from 'next/server';
import {
  LegacySession,
  Rotation,
  SessionTokens,
  Sessions,
  TokenPair,
  askedForAnother,
  clearLegacyCookies,
  clearTokens,
  endingIn,
  isFresh,
  legacySessions,
  noteEnding,
  noteRotated,
  proxyKey,
  readTokens,
  refreshOnce,
  rememberLegacyDone,
  sessionsIn,
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

export function forwardedHeaders(request: NextRequest, service: Service): Record<string, string> {
  const headers: Record<string, string> = {
    'x-request-id': request.headers.get('x-request-id') ?? randomUUID(),
  };
  const address = clientAddress(request);
  if (service === 'engine' && process.env.FRONTEND_PROXY_KEY && address) {
    headers['x-proxy-key'] = proxyKey();
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
  let text: string;
  try {
    response = await fetch(`${SERVICES[service]()}${path}`, {
      ...options,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...forwardedHeaders(request, service),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    text = await response.text();
  } catch {
    const name = service === 'engine' ? 'The matching engine' : 'The settlement service';
    return { status: 503, body: { message: `${name} is unavailable, try again shortly` } };
  }
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

export const endedTheSession = ({ body }: UpstreamResult) =>
  (body as { code?: unknown } | null)?.code === SESSION_ENDED;

const sessionIsOver = (result: UpstreamResult) =>
  (result.status >= 200 && result.status < 300) ||
  result.status === 400 ||
  result.status === 401 ||
  endedTheSession(result);

export async function endRefreshToken(
  request: NextRequest,
  refreshToken: string,
  timeoutMs = END_SESSION_TIMEOUT_MS,
): Promise<boolean> {
  const result = await upstream(request, 'engine', '/auth/end-session', {
    method: 'POST',
    body: JSON.stringify({ refreshToken }),
    timeoutMs,
  });
  return sessionIsOver(result);
}

export async function endTokens(
  request: NextRequest,
  { refreshToken, accessToken }: Partial<TokenPair>,
  timeoutMs = END_SESSION_TIMEOUT_MS,
): Promise<boolean> {
  if (refreshToken) return endRefreshToken(request, refreshToken, timeoutMs);
  if (!accessToken) return true;
  const result = await upstream(request, 'engine', '/auth/logout', { method: 'POST', timeoutMs }, accessToken);
  return sessionIsOver(result);
}

export async function endSessions(
  request: NextRequest,
  sessions: Sessions,
  ids: string[],
  timeoutMs = END_SESSION_TIMEOUT_MS,
): Promise<string[]> {
  const over = await Promise.all(ids.map((id) => endTokens(request, sessions.get(id) ?? {}, timeoutMs)));
  const ended = ids.filter((_, index) => over[index]);
  noteEnding(ended);
  return ended;
}

export interface LegacyEnding {
  names: string[];
  marks: string[];
  complete: boolean;
}

export async function endLegacySessions(
  request: NextRequest,
  sessions: Sessions,
  timeoutMs = END_SESSION_TIMEOUT_MS,
): Promise<LegacyEnding> {
  const found = legacySessions(request, sessions);
  const ended = await Promise.all(
    found.sessions.map(async (legacy) => ((await endTokens(request, legacy, timeoutMs)) ? legacy : null)),
  );
  const over = [...found.tokenless, ...ended.filter((legacy): legacy is LegacySession => legacy !== null)];
  return {
    names: over.flatMap(({ names }) => names),
    marks: over.flatMap(({ marks }) => marks),
    complete: !found.more && !ended.includes(null),
  };
}

export interface Remainder {
  left: string[];
  oldLeft: boolean;
}

export async function endAndForget(
  request: NextRequest,
  response: NextResponse,
  sessions: Sessions,
  { end, timeout = END_SESSION_TIMEOUT_MS }: { end: string[]; timeout?: number },
): Promise<Remainder> {
  const [ended, legacy] = await Promise.all([
    endSessions(request, sessions, end, timeout),
    endLegacySessions(request, sessions, timeout),
  ]);
  clearTokens(response, ended);
  rememberLegacyDone(request, response, legacy.marks, sessions);
  clearLegacyCookies(response, legacy.names);
  return { left: end.filter((id) => !ended.includes(id)), oldLeft: !legacy.complete };
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
  const sessions = sessionsIn(request);
  const ending = endingIn(request, sessions);
  const tokens = readTokens(request, sessions, ending);
  if (askedForAnother(request, sessions, ending)) return sessionChanged();
  const [response, ended] = await Promise.all([callWith(request, tokens, call), endSessions(request, sessions, ending)]);
  clearTokens(response, ended);
  return response;
}

export type SessionCall =
  | { kind: 'answered'; result: UpstreamResult; rotated: TokenPair | null }
  | { kind: 'over' }
  | { kind: 'unavailable'; rotated: TokenPair | null };

const rotationFailed = (outcome: Rotation): SessionCall =>
  outcome.kind === 'invalid' ? { kind: 'over' } : { kind: 'unavailable', rotated: null };

export async function callRotating(
  request: NextRequest,
  tokens: Partial<TokenPair>,
  call: (accessToken: string) => Promise<UpstreamResult>,
  endTimeoutMs = END_SESSION_TIMEOUT_MS,
): Promise<SessionCall> {
  const { refreshToken } = tokens;
  const rotate = () => rotateTokens(request, { refreshToken: refreshToken as string, accessToken: tokens.accessToken });
  let rotated: TokenPair | null = null;
  let accessToken = tokens.accessToken;

  if (!isFresh(accessToken) && refreshToken) {
    const outcome = await rotate();
    if (outcome.kind !== 'rotated') return rotationFailed(outcome);
    rotated = outcome.tokens;
    accessToken = rotated.accessToken;
  }
  if (!accessToken) return { kind: 'over' };

  let result = await call(accessToken);
  if (result.status === 401 && refreshToken && !rotated) {
    const outcome = await rotate();
    if (outcome.kind !== 'rotated') return rotationFailed(outcome);
    rotated = outcome.tokens;
    result = await call(rotated.accessToken);
  }
  if (result.status !== 401) return { kind: 'answered', result, rotated };
  if (rotated && !(await endRefreshToken(request, rotated.refreshToken, endTimeoutMs))) {
    return { kind: 'unavailable', rotated };
  }
  return { kind: 'over' };
}

async function callWith(
  request: NextRequest,
  tokens: ReturnType<typeof readTokens>,
  call: (accessToken: string) => Promise<UpstreamResult>,
): Promise<NextResponse> {
  const outcome = await callRotating(request, tokens, call);
  if (outcome.kind === 'over') return unauthorized(tokens.session);
  const response =
    outcome.kind === 'answered' ? NextResponse.json(outcome.result.body, { status: outcome.result.status }) : unavailable();
  if (outcome.rotated) {
    storeTokens(response, outcome.rotated, tokens.session);
    noteRotated(outcome.rotated);
  }
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
