import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { replayInstrument } from '../../src/tools/replay-check';
import { createApp, eventually, listOrders, range, register, resetState, submit } from './harness';

describe('offline replay check', () => {
  let app: INestApplication;
  let redis: Redis;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
    redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  });

  afterEach(async () => {
    await redis.quit();
    await app.close();
  });

  async function trade() {
    const [seller, buyer] = [await register(app), await register(app)];
    await Promise.all(
      range(10).map((i) =>
        submit(app, i % 2 ? seller : buyer, {
          side: i % 2 ? 'sell' : 'buy',
          price: `${100 + (i % 3)}.00`,
          quantity: '1.5',
        }).expect(202),
      ),
    );
    await eventually(async () => {
      const orders = [...(await listOrders(app, seller)), ...(await listOrders(app, buyer))];
      expect(orders).toHaveLength(10);
    });
  }

  it('agrees with what the engine stored after a burst of matching', async () => {
    await trade();

    const result = await replayInstrument(app.get(DataSource), redis, 'ABC');

    expect(result.problems).toEqual([]);
    expect(result.commands).toBe(10);
    expect(result.trades).toBeGreaterThan(0);
  });

  it('compares only what the engine has applied so far, so it can run against a live system', async () => {
    await trade();
    const dataSource = app.get(DataSource);
    await dataSource.query(`UPDATE instrument_state SET "lastCommandId" = '0-0' WHERE instrument = 'ABC'`);
    await dataSource.query(`DELETE FROM trades WHERE instrument = 'ABC'`);
    await dataSource.query(`DELETE FROM orders WHERE instrument = 'ABC'`);

    const result = await replayInstrument(dataSource, redis, 'ABC');

    expect(result.problems).toEqual([]);
    expect(result.commands).toBe(0);
    expect(result.pendingCommands).toBe(10);
  });

  it('notices an engine position that the stream does not contain', async () => {
    await trade();
    await app
      .get(DataSource)
      .query(`UPDATE instrument_state SET "lastCommandId" = '1-1' WHERE instrument = 'ABC'`);

    const result = await replayInstrument(app.get(DataSource), redis, 'ABC');

    expect(result.problems).toContainEqual('the engine says it applied 1-1, which is not in the stream');
  });

  it('notices a stored trade that the command stream does not explain', async () => {
    await trade();
    await app.get(DataSource).query(`UPDATE trades SET quantity = quantity + 1 WHERE seq = '1'`);

    const result = await replayInstrument(app.get(DataSource), redis, 'ABC');

    expect(result.problems).toEqual(['trade #1 differs from the replay']);
  });

  it('notices a stored order the stream never accepted', async () => {
    await trade();
    await app.get(DataSource).query(
      `INSERT INTO orders (id, "ownerId", instrument, side, price, quantity, "remainingQuantity", status, "createdAt", seq)
       VALUES ('00000000-0000-4000-8000-000000000001', 'ghost', 'ABC', 'buy', 1, 1, 1, 'open', now(), 999)`,
    );

    const result = await replayInstrument(app.get(DataSource), redis, 'ABC');

    expect(result.problems).toContainEqual(expect.stringMatching(/open orders, replay leaves/));
  });

  it('notices a finished order stored with another outcome than the replay gives', async () => {
    await trade();
    await app
      .get(DataSource)
      .query(
        `UPDATE orders SET status = 'cancelled' WHERE id = (SELECT id FROM orders WHERE status = 'filled' LIMIT 1)`,
      );

    const result = await replayInstrument(app.get(DataSource), redis, 'ABC');

    expect(result.problems).toContainEqual(expect.stringMatching(/^order .* differs from the replay$/));
  });
});
