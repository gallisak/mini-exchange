import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { LedgerService } from '../../src/ledger/ledger.service';
import {
  DEAD_LETTER_STREAM,
  GROUP,
  TRADE_STREAM,
  balances,
  createApp,
  eventually,
  groupState,
  publishTrade,
  redisClient,
  resetState,
  settle,
  trade,
} from './harness';

describe('trade stream consumer', () => {
  let app: INestApplication | undefined;
  let redis: Redis;

  beforeEach(async () => {
    await resetState();
    redis = redisClient();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await redis.quit();
  });

  const settledAll = (count: number) =>
    eventually(async () => {
      expect(await groupState(redis)).toEqual({ pending: 0, read: count });
    });

  it('settles a trade published on the instrument stream and acknowledges it', async () => {
    app = await createApp();
    const executed = trade();

    await publishTrade(redis, executed);

    await settledAll(1);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
    expect((await balances(app, executed.sellerId)).ABC).toBe('998.00000000');
  });

  it('moves money once when the stream delivers the same trade twice', async () => {
    app = await createApp();
    const executed = trade();

    await publishTrade(redis, executed);
    await publishTrade(redis, executed);

    await settledAll(2);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
    expect((await balances(app, executed.sellerId)).USD).toBe('100021.00');
  });

  it('settles once a trade whose earlier delivery committed but was never acknowledged', async () => {
    const executed = trade();
    await redis.xgroup('CREATE', TRADE_STREAM, GROUP, '0', 'MKSTREAM');
    await publishTrade(redis, executed);
    await redis.xreadgroup('GROUP', GROUP, 'crashed', 'COUNT', 1, 'STREAMS', TRADE_STREAM, '>');
    app = await createApp();
    await settle(app, executed).expect(200);

    await settledAll(1);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
  });

  it('settles a trade that a crashed consumer took but never settled', async () => {
    const executed = trade();
    await redis.xgroup('CREATE', TRADE_STREAM, GROUP, '0', 'MKSTREAM');
    await publishTrade(redis, executed);
    await redis.xreadgroup('GROUP', GROUP, 'crashed', 'COUNT', 1, 'STREAMS', TRADE_STREAM, '>');

    app = await createApp();

    await settledAll(1);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
  });

  it('keeps retrying a trade the ledger failed to settle instead of dead-lettering it', async () => {
    app = await createApp();
    const ledger = app.get(LedgerService);
    const settleTrade = ledger.settleTrade.bind(ledger);
    let failures = 0;
    jest.spyOn(ledger, 'settleTrade').mockImplementation(async (body) => {
      if (failures < 4) {
        failures += 1;
        throw new Error('Connection terminated unexpectedly');
      }
      return settleTrade(body);
    });
    const executed = trade();

    await publishTrade(redis, executed);

    await eventually(async () => {
      expect(await groupState(redis)).toEqual({ pending: 0, read: 1 });
    }, 15000);
    expect(failures).toBe(4);
    expect(await redis.exists(DEAD_LETTER_STREAM)).toBe(0);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
  });

  it('dead-letters a malformed event and keeps settling the next ones', async () => {
    app = await createApp();
    const executed = trade();

    const malformed = await publishTrade(redis, '{not json');
    await publishTrade(redis, { ...trade(), quantity: '0' });
    await publishTrade(redis, executed);

    await settledAll(3);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
    const dead = (await redis.xrange(DEAD_LETTER_STREAM, '-', '+')) as [string, string[]][];
    expect(dead).toHaveLength(2);
    expect(dead[0][1].slice(0, 4)).toEqual(['stream', TRADE_STREAM, 'id', malformed]);
  });

  it('dead-letters a trade id reused with different details', async () => {
    app = await createApp();
    const executed = trade();

    await publishTrade(redis, executed);
    await publishTrade(redis, { ...executed, price: '99.00' });

    await settledAll(2);
    expect(await redis.xlen(DEAD_LETTER_STREAM)).toBe(1);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
  });
});
