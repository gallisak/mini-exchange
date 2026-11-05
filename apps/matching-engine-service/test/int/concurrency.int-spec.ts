import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { applyCommands } from '../../src/orders/engine/apply-commands';
import { commandStreamKey, decodeCommand } from '../../src/orders/engine/order-command';
import { Order } from '../../src/orders/entities/order.entity';
import { TradeRecord } from '../../src/orders/entities/trade-record.entity';
import { QUANTITY_SCALE, toUnits } from '../../src/common/decimal';
import {
  restingOrders,
  createApp,
  eventually,
  listOrders,
  range,
  register,
  resetState,
  submit,
} from './harness';
import { asReference, crossedPairsBetweenOwners, referenceMatch } from '../reference-matcher';

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

async function readCommandStream(instrument: string) {
  const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
  const entries = await redis.xrange(commandStreamKey(instrument), '-', '+');
  await redis.quit();
  return entries.map(([id, fields]) => ({ id, command: decodeCommand(fields) }));
}

describe('concurrent order flow', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('ends in the same trades and book as a replay and as an independent price-time reference, in arrival order', async () => {
    const users = await Promise.all(range(5).map(() => register(app)));
    const random = seededRandom(42);
    const orders = range(200).map(() => ({
      user: users[Math.floor(random() * users.length)],
      side: random() < 0.5 ? ('buy' as const) : ('sell' as const),
      price: (95 + Math.floor(random() * 10)).toFixed(2),
      quantity: (1 + Math.floor(random() * 30) / 10).toFixed(1),
    }));

    const responses = await Promise.all(
      orders.map(({ user, side, price, quantity }) => submit(app, user, { side, price, quantity })),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);

    const marker = await submit(app, users[0], { side: 'buy', price: '0.01', quantity: '1' });
    await eventually(async () => {
      const own = await listOrders(app, users[0]);
      expect(own.some((order) => order.id === marker.body.orderId)).toBe(true);
    }, 15000);

    const stream = await readCommandStream('ABC');
    const replay = applyCommands(
      'ABC',
      { bids: [], asks: [] },
      { lastCommandId: '0-0', orderSeq: 0n, tradeSeq: 0n, bookSeq: 0n },
      stream,
      new Set(),
    );
    const reference = referenceMatch(stream);
    const dataSource = app.get(DataSource);
    const trades = await dataSource
      .getRepository(TradeRecord)
      .find({ where: { instrument: 'ABC' }, order: { seq: 'ASC' } });
    const stored = await dataSource.getRepository(Order).find({ where: { instrument: 'ABC' } });
    const current = await restingOrders(app);

    expect(trades.length).toBeGreaterThan(0);
    expect(trades.map((t) => [t.id, t.buyOrderId, t.sellOrderId, t.price, t.quantity])).toEqual(
      replay.trades.map((t) => [t.id, t.buyOrderId, t.sellOrderId, t.price, t.quantity]),
    );
    expect(current.bids.map((o) => [o.id, o.remainingQuantity])).toEqual(
      replay.book.bids.map((o) => [o.id, o.remainingQuantity]),
    );
    expect(current.asks.map((o) => [o.id, o.remainingQuantity])).toEqual(
      replay.book.asks.map((o) => [o.id, o.remainingQuantity]),
    );

    const actual = asReference(trades, current.bids, current.asks);
    expect(actual.trades).toEqual(reference.trades);
    expect(actual.bids.map((o) => [o.id, o.remaining])).toEqual(
      reference.bids.map((o) => [o.id, o.remaining]),
    );
    expect(actual.asks.map((o) => [o.id, o.remaining])).toEqual(
      reference.asks.map((o) => [o.id, o.remaining]),
    );
    expect(crossedPairsBetweenOwners(actual)).toEqual([]);

    const acceptedIds = [...responses, marker].map((response) => response.body.orderId);
    expect(new Set(acceptedIds).size).toBe(201);
    expect(stored.map((order) => order.id).sort()).toEqual([...acceptedIds].sort());

    for (const order of stored) {
      const filled = trades
        .filter((t) => t.buyOrderId === order.id || t.sellOrderId === order.id)
        .reduce((sum, t) => sum + toUnits(t.quantity, QUANTITY_SCALE), 0n);
      expect(toUnits(order.quantity, QUANTITY_SCALE) - toUnits(order.remainingQuantity, QUANTITY_SCALE)).toBe(
        filled,
      );
    }
  });
});
