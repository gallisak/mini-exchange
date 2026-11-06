import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { replayDeadLetters } from '../../src/consumer/dead-letters';
import {
  DEAD_LETTER_STREAM,
  TRADE_STREAM,
  balances,
  createApp,
  eventually,
  redisClient,
  resetState,
  trade,
} from './harness';

describe('dead-lettered trades', () => {
  let app: INestApplication;
  let redis: Redis;

  beforeEach(async () => {
    await resetState();
    redis = redisClient();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
    await redis.quit();
  });

  it('go back on their stream and settle once an operator replays them', async () => {
    const executed = trade();
    await redis.xadd(
      DEAD_LETTER_STREAM,
      '*',
      'stream',
      TRADE_STREAM,
      'id',
      '1-0',
      'reason',
      'gave up after 20 deliveries: numeric field overflow',
      'deliveries',
      '10',
      'fields',
      JSON.stringify({ type: 'trade.executed', payload: JSON.stringify(executed) }),
    );

    expect(await replayDeadLetters(redis)).toBe(1);

    await eventually(async () => expect((await balances(app, executed.buyerId)).USD).toBe('99979.00'));
    expect(await redis.xlen(DEAD_LETTER_STREAM)).toBe(0);
  });

  it('stay dead-lettered when they were malformed or conflicting, since replaying them changes nothing', async () => {
    const letter = (reason: string) =>
      redis.xadd(
        DEAD_LETTER_STREAM,
        '*',
        'stream',
        TRADE_STREAM,
        'id',
        '1-0',
        'reason',
        reason,
        'deliveries',
        '1',
        'fields',
        JSON.stringify({ type: 'trade.executed', payload: '{not json' }),
      );
    await letter('payload is not JSON');
    await letter('trade 1 was settled with different details');

    expect(await replayDeadLetters(redis)).toBe(0);
    expect(await redis.xlen(DEAD_LETTER_STREAM)).toBe(2);
    expect(await redis.xlen(TRADE_STREAM)).toBe(0);
  });
});
