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
      'numeric field overflow',
      'deliveries',
      '10',
      'fields',
      JSON.stringify({ type: 'trade.executed', payload: JSON.stringify(executed) }),
    );

    expect(await replayDeadLetters(redis)).toBe(1);

    await eventually(async () => expect((await balances(app, executed.buyerId)).USD).toBe('99979.00'));
    expect(await redis.xlen(DEAD_LETTER_STREAM)).toBe(0);
  });
});
