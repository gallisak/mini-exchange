import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'crypto';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { buildDataSourceOptions } from '../../src/database/data-source';

export interface TradeBody {
  tradeId: string;
  instrument: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  price: string;
  quantity: string;
  executedAt: string;
  traceId?: string;
}

export const TRADE_STREAM = 'trades:ABC';
export const GROUP = 'settlement';
export const DEAD_LETTER_STREAM = 'settlement:dead-letter';

export function redisClient(): Redis {
  return new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
}

export async function resetState(): Promise<void> {
  const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  await dataSource.query(
    `TRUNCATE "ledger_entries", "ledger_transactions", "accounts", "settled_trades", "reconciliation_checkpoints" RESTART IDENTITY CASCADE`,
  );
  await dataSource.destroy();

  const redis = redisClient();
  await redis.flushdb();
  await redis.quit();
}

export async function eventually(assertion: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

export function accessToken(userId: string, role = 'user', sessionId?: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userId,
    email: `${userId}@example.com`,
    role,
    ...(sessionId ? { sid: sessionId } : {}),
    iat: now,
    exp: now + 900,
  })}`;
  const signature = createHmac('sha256', process.env.JWT_ACCESS_SECRET as string)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

export function trade(overrides: Partial<TradeBody> = {}): TradeBody {
  return {
    tradeId: randomUUID(),
    instrument: 'ABC',
    buyOrderId: randomUUID(),
    sellOrderId: randomUUID(),
    buyerId: randomUUID(),
    sellerId: randomUUID(),
    price: '10.50',
    quantity: '2',
    executedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function settle(
  app: INestApplication,
  body: TradeBody,
  key: string | null = process.env.SETTLEMENT_INTERNAL_KEY as string,
) {
  const call = request(app.getHttpServer()).post('/trades/settle');
  return (key === null ? call : call.set('x-internal-key', key)).send(body);
}

export async function balances(app: INestApplication, userId: string): Promise<Record<string, string>> {
  const response = await request(app.getHttpServer())
    .get('/wallets/me')
    .set('authorization', `Bearer ${accessToken(userId)}`)
    .expect(200);
  return Object.fromEntries(
    (response.body.balances as { asset: string; balance: string }[]).map((row) => [
      row.asset,
      row.balance,
    ]),
  );
}

export async function publishTrade(redis: Redis, body: TradeBody | string): Promise<string> {
  return (await redis.xadd(
    TRADE_STREAM,
    '*',
    'type',
    'trade.executed',
    'payload',
    typeof body === 'string' ? body : JSON.stringify(body),
  )) as string;
}

export async function groupState(redis: Redis, stream = TRADE_STREAM) {
  const groups = (await redis.xinfo('GROUPS', stream).catch(() => [])) as (string | number)[][];
  const group = groups
    .map((fields) => {
      const info: Record<string, string | number> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) info[String(fields[i])] = fields[i + 1];
      return info;
    })
    .find((info) => info.name === GROUP);
  return group ? { pending: Number(group.pending), read: Number(group['entries-read']) } : null;
}

export async function startAdminDirectory() {
  const revoked = new Set<string>();
  const server = createServer((req, res) => {
    const match = /^\/auth\/admins\/([^/?]+)$/.exec(req.url ?? '');
    if (!match || req.headers['x-internal-key'] !== process.env.ENGINE_INTERNAL_KEY) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ admin: !revoked.has(match[1]) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    revoked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
