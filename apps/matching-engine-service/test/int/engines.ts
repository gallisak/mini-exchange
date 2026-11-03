import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { resolve } from 'path';
import Redis from 'ioredis';
import { instrumentLockKey } from '../../src/orders/engine/instrument-ownership.service';
import { OrderBody, OrderRow, TestUser, eventually } from './harness';

export interface EngineProcess {
  name: string;
  url: string;
  child: ChildProcess;
  logs: string[];
}

export async function startEngine(
  name: string,
  port: number,
  env: Record<string, string> = {},
): Promise<EngineProcess> {
  const child = spawn(process.execPath, ['dist/main'], {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, PORT: String(port), INSTANCE_ID: name, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const engine = { name, url: `http://localhost:${port}`, child, logs };
  await eventually(async () => {
    const response = await fetch(`${engine.url}/orders`);
    expect(response.status).toBe(401);
  }, 20000);
  return engine;
}

export async function stopEngine(engine: EngineProcess, signal: NodeJS.Signals): Promise<void> {
  if (engine.child.exitCode !== null || engine.child.signalCode !== null) return;
  const exited = once(engine.child, 'exit');
  engine.child.kill(signal);
  await exited;
}

export async function lockOwner(instrument: string): Promise<string | null> {
  const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  const owner = await redis.get(instrumentLockKey(instrument));
  await redis.quit();
  return owner;
}

export async function waitForOwner(instrument: string, name: string, timeoutMs = 10000) {
  await eventually(async () => {
    expect(await lockOwner(instrument)).toMatch(new RegExp(`^${name}`));
  }, timeoutMs);
}

export function api(engine: EngineProcess) {
  const json = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${engine.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  return {
    async register(): Promise<TestUser> {
      const { body } = await json('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: `user-${randomUUID()}@example.com`, password: 'password123' }),
      });
      const payload = JSON.parse(Buffer.from(body.accessToken.split('.')[1], 'base64url').toString());
      return { token: body.accessToken, userId: payload.sub };
    },
    submit(user: TestUser, order: OrderBody) {
      return json('/orders', {
        method: 'POST',
        headers: { authorization: `Bearer ${user.token}`, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ instrument: 'ABC', ...order }),
      });
    },
    async orders(user: TestUser): Promise<OrderRow[]> {
      const { body } = await json('/orders', { headers: { authorization: `Bearer ${user.token}` } });
      return body;
    },
  };
}
