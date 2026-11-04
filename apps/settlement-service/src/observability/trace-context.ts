import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

const storage = new AsyncLocalStorage<{ traceId: string }>();
const TRACE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

export function runWithTrace<T>(traceId: string | undefined, work: () => T): T {
  return storage.run({ traceId: traceId ?? randomUUID() }, work);
}

export function acceptTraceId(candidate: unknown): string {
  return typeof candidate === 'string' && TRACE_ID.test(candidate) ? candidate : randomUUID();
}
