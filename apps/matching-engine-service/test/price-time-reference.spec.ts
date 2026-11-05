import { applyCommands, EngineState } from '../src/orders/engine/apply-commands';
import { StreamCommand } from '../src/orders/engine/order-command';
import { BookSnapshot } from '../src/orders/order-book.types';
import { uuidV5 } from '../src/common/uuid';
import { asReference, crossedPairsBetweenOwners, referenceMatch } from './reference-matcher';

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const OWNERS = ['a', 'b', 'c', 'd'].map((name) => uuidV5(`owner:${name}`));

function randomCommands(seed: number, count: number): StreamCommand[] {
  const random = seededRandom(seed);
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const submitted: { orderId: string; ownerId: string }[] = [];
  const commands: StreamCommand[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${1_700_000_000_000 + i}-0`;
    const roll = random();
    if (roll < 0.15 && submitted.length > 0) {
      const target = pick(submitted);
      const ownerId = random() < 0.8 ? target.ownerId : pick(OWNERS);
      commands.push({ id, command: { type: 'cancel', orderId: target.orderId, ownerId } });
      continue;
    }
    if (roll < 0.2 && submitted.length > 0) {
      const target = pick(submitted).orderId;
      const again = commands.find(
        (entry) => entry.command?.type === 'submit' && entry.command.orderId === target,
      );
      if (again) {
        commands.push({ id, command: again.command });
        continue;
      }
    }
    const orderId = uuidV5(`order:${seed}:${i}`);
    const ownerId = pick(OWNERS);
    submitted.push({ orderId, ownerId });
    commands.push({
      id,
      command: {
        type: 'submit',
        orderId,
        ownerId,
        side: random() < 0.5 ? 'buy' : 'sell',
        price: (95 + Math.floor(random() * 10) + (random() < 0.3 ? 0.5 : 0)).toFixed(2),
        quantity: (0.1 + Math.floor(random() * 50) / 10).toFixed(random() < 0.5 ? 1 : 8),
      },
    });
  }
  return commands;
}

function runInBatches(commands: StreamCommand[], random: () => number) {
  let book: BookSnapshot = { bids: [], asks: [] };
  let state: EngineState = { lastCommandId: '0-0', orderSeq: 0n, tradeSeq: 0n, bookSeq: 0n };
  const known = new Set<string>();
  const trades = [];
  for (let start = 0; start < commands.length; ) {
    const size = 1 + Math.floor(random() * 40);
    const batch = commands.slice(start, start + size);
    const result = applyCommands('ABC', book, state, batch, known);
    for (const order of result.orders) known.add(order.id);
    trades.push(...result.trades);
    book = result.book;
    state = result.state;
    start += size;
  }
  return { book, trades };
}

describe('matching against an independent reference implementation', () => {
  it.each(Array.from({ length: 40 }, (_, seed) => seed + 1))(
    'produces the same trades and book as the reference for seed %i',
    (seed) => {
      const commands = randomCommands(seed, 300);
      const expected = referenceMatch(commands);
      const { book, trades } = runInBatches(commands, seededRandom(seed * 7919));
      const actual = asReference(trades, book.bids, book.asks);

      expect(actual.trades).toEqual(expected.trades);
      expect(actual.bids.map((o) => [o.id, o.remaining])).toEqual(
        expected.bids.map((o) => [o.id, o.remaining]),
      );
      expect(actual.asks.map((o) => [o.id, o.remaining])).toEqual(
        expected.asks.map((o) => [o.id, o.remaining]),
      );
      expect(crossedPairsBetweenOwners(actual)).toEqual([]);
    },
  );
});
