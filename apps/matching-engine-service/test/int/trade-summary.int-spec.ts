import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { instrumentLockKey } from '../../src/orders/engine/instrument-ownership.service';
import { commandStreamKey, encodeCommand } from '../../src/orders/engine/order-command';
import { TradeRecord } from '../../src/orders/entities/trade-record.entity';
import { createApp, resetState } from './harness';

describe('trade summary', () => {
  let app: INestApplication;
  let seq = 0;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  async function executed(instrument: string, price: string, quantity: string, at: string) {
    seq += 1;
    await app.get(DataSource).getRepository(TradeRecord).insert({
      id: randomUUID(),
      instrument,
      seq: String(seq),
      buyOrderId: randomUUID(),
      sellOrderId: randomUUID(),
      buyerId: randomUUID(),
      sellerId: randomUUID(),
      price,
      quantity,
      executedAt: new Date(at),
    });
  }

  const summary = (from: string, to: string) =>
    request(app.getHttpServer())
      .get('/trades/summary')
      .set('x-internal-key', process.env.ENGINE_INTERNAL_KEY as string)
      .query({ from, to });

  it('totals the trades of each instrument in the period exactly', async () => {
    await executed('ABC', '10.01', '0.12345678', '2026-11-04T10:00:00.000Z');
    await executed('ABC', '3.00', '2', '2026-11-04T10:30:00.000Z');
    await executed('DEF', '0.01', '0.00000001', '2026-11-04T10:59:59.999Z');

    const response = await summary('2026-11-04T10:00:00.000Z', '2026-11-04T11:00:00.000Z').expect(
      200,
    );

    expect(response.body).toEqual({
      from: '2026-11-04T10:00:00.000Z',
      to: '2026-11-04T11:00:00.000Z',
      firstTradeAt: '2026-11-04T10:00:00.000Z',
      pendingSince: null,
      instruments: [
        { instrument: 'ABC', count: 2, quantity: '2.12345678', notional: '7.2358023678' },
        { instrument: 'DEF', count: 1, quantity: '0.00000001', notional: '0.0000000001' },
      ],
    });
  });

  it('counts a trade at the start of the period and leaves out one at its end', async () => {
    await executed('ABC', '1.00', '1', '2026-11-04T10:00:00.000Z');
    await executed('ABC', '1.00', '5', '2026-11-04T11:00:00.000Z');
    await executed('ABC', '1.00', '7', '2026-11-04T09:59:59.999Z');

    const response = await summary('2026-11-04T10:00:00.000Z', '2026-11-04T11:00:00.000Z').expect(
      200,
    );

    expect(response.body.instruments).toEqual([
      { instrument: 'ABC', count: 1, quantity: '1.00000000', notional: '1.0000000000' },
    ]);
  });

  it('tells when the first trade of all was executed, so a first reconciliation knows where to start', async () => {
    await executed('DEF', '1.00', '1', '2026-11-02T08:00:00.000Z');
    await executed('ABC', '1.00', '1', '2026-11-03T08:00:00.000Z');

    const response = await summary('2026-11-04T10:00:00.000Z', '2026-11-04T11:00:00.000Z').expect(200);

    expect(response.body.firstTradeAt).toBe('2026-11-02T08:00:00.000Z');
  });

  it('rejects a period that is not a valid range', async () => {
    await summary('yesterday', '2026-11-04T11:00:00.000Z').expect(400);
    await summary('2026-11-04T11:00:00.000Z', '2026-11-04T10:00:00.000Z').expect(400);
    await request(app.getHttpServer())
      .get('/trades/summary')
      .set('x-internal-key', process.env.ENGINE_INTERNAL_KEY as string)
      .expect(400);
  });

  it('is not open to the public, since it scans every trade of the period', async () => {
    const period = { from: '2026-11-04T10:00:00.000Z', to: '2026-11-04T11:00:00.000Z' };

    await request(app.getHttpServer()).get('/trades/summary').query(period).expect(401);
    await request(app.getHttpServer())
      .get('/trades/summary')
      .set('x-internal-key', 'wrong')
      .query(period)
      .expect(401);
  });

  it('tells from when trades may still be missing because a book has not applied its commands yet', async () => {
    await app.close();
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    await redis.set(instrumentLockKey('ABC'), 'another-engine', 'PX', 60_000);
    app = await createApp();
    const id = (await redis.xadd(
      commandStreamKey('ABC'),
      '*',
      ...encodeCommand({
        type: 'submit',
        orderId: randomUUID(),
        ownerId: randomUUID(),
        side: 'buy',
        price: '10.00',
        quantity: '1',
      }),
    )) as string;
    await redis.quit();

    const response = await summary('2026-11-04T10:00:00.000Z', '2026-11-04T11:00:00.000Z').expect(200);

    expect(response.body.pendingSince).toBe(new Date(Number(id.split('-')[0])).toISOString());
  });
});
