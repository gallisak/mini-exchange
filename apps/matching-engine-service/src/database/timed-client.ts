import { Client } from 'pg';

const OUTCOME_UNKNOWN_IF_CUT = /^\s*(COMMIT|END)\b/i;

function textOf(config: unknown): string {
  if (typeof config === 'string') return config;
  const text = (config as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '';
}

export function clientWithReadTimeout(timeoutMs: number): typeof Client {
  return class extends Client {
    query(...args: unknown[]): never {
      const run = (Client.prototype.query as (...params: unknown[]) => unknown).apply(this, args);
      if (timeoutMs <= 0 || !(run instanceof Promise) || OUTCOME_UNKNOWN_IF_CUT.test(textOf(args[0]))) {
        return run as never;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        (this as unknown as { connection: { stream: { destroy(): void } } }).connection.stream.destroy();
      }, timeoutMs);
      return run
        .catch((error: unknown) => {
          if (timedOut) throw new Error(`Query read timeout: Postgres did not answer within ${timeoutMs} ms`);
          throw error;
        })
        .finally(() => clearTimeout(timer)) as never;
    }
  } as typeof Client;
}
