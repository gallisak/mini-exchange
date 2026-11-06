import { INestApplication } from '@nestjs/common';
import { LedgerService } from '../../src/ledger/ledger.service';
import { randomUUID } from 'crypto';
import request from 'supertest';
import {
  GROUP,
  TRADE_STREAM,
  accessToken,
  createApp,
  eventually,
  groupState,
  publishTrade,
  redisClient,
  resetState,
  settle,
  startAdminDirectory,
  trade,
} from './harness';

describe('settlement operations endpoints', () => {
  let app: INestApplication;
  let directory: Awaited<ReturnType<typeof startAdminDirectory>>;

  beforeAll(async () => {
    directory = await startAdminDirectory();
    process.env.ENGINE_URL = directory.url;
  });

  afterAll(async () => {
    await directory.close();
  });

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('reports itself healthy', async () => {
    await eventually(async () => {
      const response = await http().get('/health').expect(200);
      expect(response.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });
  });

  it('counts settled, duplicate and dead-lettered trade events', async () => {
    const redis = redisClient();
    const executed = trade();
    await http().get('/metrics').expect(401);
    await http().get('/metrics').set('authorization', 'Bearer wrong-key').expect(401);
    const metrics = () =>
      http().get('/metrics').set('authorization', `Bearer ${process.env.SETTLEMENT_INTERNAL_KEY}`);
    const before = await metrics().expect(200);
    const count = (text: string, result: string) =>
      Number(new RegExp(`settlement_trade_events_total\\{result="${result}"\\} (\\d+)`).exec(text)?.[1] ?? 0);

    await publishTrade(redis, executed);
    await publishTrade(redis, executed);
    await publishTrade(redis, '{broken');
    await eventually(async () => expect(await groupState(redis)).toEqual({ pending: 0, read: 3 }));
    await redis.quit();

    const after = (await metrics().expect(200)).text;
    expect(count(after, 'settled') - count(before.text, 'settled')).toBe(1);
    expect(count(after, 'duplicate') - count(before.text, 'duplicate')).toBe(1);
    expect(count(after, 'dead_lettered') - count(before.text, 'dead_lettered')).toBe(1);
  });

  it('shows the consumer backlog and dead letters to admins only', async () => {
    const redis = redisClient();
    await publishTrade(redis, '{broken');
    await eventually(async () => expect(await groupState(redis)).toEqual({ pending: 0, read: 1 }));
    await redis.quit();
    await settle(app, trade()).expect(200);

    await http().get('/ops/status').expect(401);
    await http().get('/ops/status').set('authorization', `Bearer ${accessToken(randomUUID())}`).expect(403);
    const response = await http()
      .get('/ops/status')
      .set('authorization', `Bearer ${accessToken(randomUUID(), 'admin')}`)
      .expect(200);

    expect(response.body.group).toBe('settlement');
    expect(response.body.deadLetters).toBe(1);
    expect(response.body.streams).toContainEqual({
      stream: TRADE_STREAM,
      length: 1,
      pending: 0,
      lag: 0,
      consumers: 1,
      retrying: 0,
      oldestPendingMs: null,
    });
  });

  it('shows trades that keep failing to settle and how long the oldest has waited', async () => {
    const ledger = app.get(LedgerService);
    jest.spyOn(ledger, 'settle').mockRejectedValue(new Error('Connection terminated unexpectedly'));
    const redis = redisClient();
    await publishTrade(redis, trade());
    await redis.quit();
    const status = async () =>
      (
        await http()
          .get('/ops/status')
          .set('authorization', `Bearer ${accessToken(randomUUID(), 'admin')}`)
          .expect(200)
      ).body.streams.find((row: { stream: string }) => row.stream === TRADE_STREAM);

    await eventually(async () => {
      const row = await status();
      expect(row.retrying).toBe(1);
      expect(row.oldestPendingMs).toBeGreaterThan(0);
    }, 10000);
  });

  it('forgets consumers that left nothing pending and have been idle for long', async () => {
    const redis = redisClient();
    await redis.xgroup('CREATE', TRADE_STREAM, GROUP, '0', 'MKSTREAM').catch(() => undefined);
    await redis.xreadgroup('GROUP', GROUP, 'gone-consumer', 'COUNT', 1, 'STREAMS', TRADE_STREAM, '>');

    await eventually(async () => {
      const consumers = (await redis.xinfo('CONSUMERS', TRADE_STREAM, GROUP)) as string[][];
      expect(consumers.map((fields) => fields[1])).not.toContain('gone-consumer');
    }, 10000);
    await redis.quit();
  });

  it('stops honouring an admin token as soon as the engine no longer has the account as an admin', async () => {
    const admin = randomUUID();
    const token = accessToken(admin, 'admin');
    await http().get('/ops/status').set('authorization', `Bearer ${token}`).expect(200);

    directory.revoked.add(admin);

    await http().get('/ops/status').set('authorization', `Bearer ${token}`).expect(403);
  });
});
