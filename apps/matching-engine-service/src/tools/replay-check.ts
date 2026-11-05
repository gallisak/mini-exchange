import 'reflect-metadata';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../database/data-source';
import { INSTRUMENTS } from '../common/instruments';
import { intEnv } from '../common/env';
import { applyCommands } from '../orders/engine/apply-commands';
import { StreamCommand, commandStreamKey, decodeCommand } from '../orders/engine/order-command';
import { InstrumentState } from '../orders/entities/instrument-state.entity';
import { Order } from '../orders/entities/order.entity';
import { TradeRecord } from '../orders/entities/trade-record.entity';
import { PRICE_SCALE, QUANTITY_SCALE, toUnits } from '../common/decimal';

const PAGE = 1_000;
const OPEN: string[] = ['open', 'partially_filled'];

export interface InstrumentReplay {
  instrument: string;
  commands: number;
  pendingCommands: number;
  trades: number;
  openOrders: number;
  problems: string[];
}

async function readStream(redis: Redis, instrument: string): Promise<StreamCommand[]> {
  const commands: StreamCommand[] = [];
  let start = '-';
  for (;;) {
    const page = (await redis.xrange(commandStreamKey(instrument), start, '+', 'COUNT', PAGE)) as [
      string,
      string[],
    ][];
    for (const [id, fields] of page) commands.push({ id, command: decodeCommand(fields) });
    if (page.length < PAGE) return commands;
    start = `(${page[page.length - 1][0]}`;
  }
}

const sameAmount = (a: string, b: string, scale: number) => toUnits(a, scale) === toUnits(b, scale);

function streamOrder(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(BigInt);
  const [bMs, bSeq] = b.split('-').map(BigInt);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  return aSeq === bSeq ? 0 : aSeq < bSeq ? -1 : 1;
}

export async function replayInstrument(
  dataSource: DataSource,
  redis: Redis,
  instrument: string,
): Promise<InstrumentReplay> {
  const { state, trades, orders } = await dataSource.transaction('REPEATABLE READ', async (manager) => ({
    state: await manager.findOneBy(InstrumentState, { instrument }),
    trades: await manager.find(TradeRecord, { where: { instrument }, order: { seq: 'ASC' } }),
    orders: await manager.find(Order, {
      where: { instrument },
      select: { id: true, status: true, remainingQuantity: true },
    }),
  }));
  const open = orders.filter((order) => OPEN.includes(order.status));
  const appliedUpTo = state?.lastCommandId ?? '0-0';
  const stream = await readStream(redis, instrument);
  const commands = stream.filter((entry) => streamOrder(entry.id, appliedUpTo) <= 0);
  const replay = applyCommands(
    instrument,
    { bids: [], asks: [] },
    { lastCommandId: '0-0', orderSeq: 0n, tradeSeq: 0n, bookSeq: 0n },
    commands,
    new Set(),
  );
  const problems: string[] = [];

  if (appliedUpTo !== '0-0' && commands[commands.length - 1]?.id !== appliedUpTo) {
    problems.push(`the engine says it applied ${appliedUpTo}, which is not in the stream`);
  }
  if (trades.length !== replay.trades.length) {
    problems.push(`stored ${trades.length} trades, replay produced ${replay.trades.length}`);
  }
  replay.trades.forEach((expected, index) => {
    const stored = trades[index];
    if (
      !stored ||
      stored.id !== expected.id ||
      stored.seq !== expected.seq ||
      stored.buyOrderId !== expected.buyOrderId ||
      stored.sellOrderId !== expected.sellOrderId ||
      !sameAmount(stored.price, expected.price, PRICE_SCALE) ||
      !sameAmount(stored.quantity, expected.quantity, QUANTITY_SCALE)
    ) {
      if (problems.length < 20) problems.push(`trade #${index + 1} differs from the replay`);
    }
  });

  const resting = new Map(
    [...replay.book.bids, ...replay.book.asks].map((order) => [order.id, order.remainingQuantity]),
  );
  if (open.length !== resting.size) {
    problems.push(`stored ${open.length} open orders, replay leaves ${resting.size}`);
  }
  for (const order of open) {
    const remaining = resting.get(order.id);
    if (remaining === undefined || !sameAmount(remaining, order.remainingQuantity, QUANTITY_SCALE)) {
      if (problems.length < 20) problems.push(`open order ${order.id} differs from the replay`);
    }
  }

  const replayed = new Map(replay.orders.map((order) => [order.id, order]));
  if (orders.length !== replayed.size) {
    problems.push(`stored ${orders.length} orders, replay accepted ${replayed.size}`);
  }
  for (const order of orders) {
    const expected = replayed.get(order.id);
    if (
      expected &&
      (expected.status !== order.status ||
        !sameAmount(expected.remainingQuantity, order.remainingQuantity, QUANTITY_SCALE))
    ) {
      if (problems.length < 20) problems.push(`order ${order.id} differs from the replay`);
    }
  }

  return {
    instrument,
    commands: commands.length,
    pendingCommands: stream.length - commands.length,
    trades: trades.length,
    openOrders: open.length,
    problems,
  };
}

async function main(): Promise<number> {
  const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: intEnv('REDIS_PORT', 6379),
  });
  try {
    const instruments: InstrumentReplay[] = [];
    for (const instrument of INSTRUMENTS) {
      instruments.push(await replayInstrument(dataSource, redis, instrument));
    }
    const matches = instruments.every((result) => result.problems.length === 0);
    process.stdout.write(`${JSON.stringify({ matches, instruments }, null, 2)}\n`);
    return matches ? 0 : 1;
  } finally {
    await redis.quit();
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    },
  );
}
