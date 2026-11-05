import { EngineState, applyCommands } from '../src/orders/engine/apply-commands';
import { OrderCommand, StreamCommand } from '../src/orders/engine/order-command';
import { uuidV5 } from '../src/common/uuid';

const oid = (name: string) => uuidV5(name);

const empty = { bids: [], asks: [] };
const initial: EngineState = { lastCommandId: '0-0', orderSeq: 0n, tradeSeq: 0n, bookSeq: 0n };

function submit(
  id: string,
  orderId: string,
  ownerId: string,
  side: 'buy' | 'sell',
  price: string,
  quantity = '1.00000000',
): StreamCommand {
  return { id, command: { type: 'submit', orderId: oid(orderId), ownerId, side, price, quantity } };
}

function cancel(id: string, orderId: string, ownerId: string): StreamCommand {
  return { id, command: { type: 'cancel', orderId: oid(orderId), ownerId } };
}

describe('applyCommands', () => {
  it('applies commands in stream order and takes order time from the stream id', () => {
    const result = applyCommands(
      'ABC',
      empty,
      initial,
      [submit('1000-0', 'sell-1', 'A', 'sell', '100.00'), submit('2000-0', 'buy-1', 'B', 'buy', '100.00')],
      new Set(),
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      sellOrderId: oid('sell-1'),
      buyOrderId: oid('buy-1'),
      seq: '1',
      executedAt: new Date(2000),
    });
    expect(result.orders.map((o) => [o.id, o.status, o.seq, o.createdAt.getTime()])).toEqual([
      [oid('sell-1'), 'filled', '1', 1000],
      [oid('buy-1'), 'filled', '2', 2000],
    ]);
    expect(result.state).toEqual({
      lastCommandId: '2000-0',
      orderSeq: 2n,
      tradeSeq: 1n,
      bookSeq: 1n,
    });
  });

  it('breaks a price tie by sequence when orders share a millisecond', () => {
    const result = applyCommands(
      'ABC',
      empty,
      initial,
      [
        submit('1000-0', 'sell-first', 'A', 'sell', '100.00'),
        submit('1000-1', 'sell-second', 'C', 'sell', '100.00'),
        submit('1000-2', 'buy-1', 'B', 'buy', '100.00'),
      ],
      new Set(),
    );

    expect(result.trades.map((t) => t.sellOrderId)).toEqual([oid('sell-first')]);
    expect(result.book.asks.map((o) => o.id)).toEqual([oid('sell-second')]);
  });

  it('skips a submit whose order already exists or repeats in the batch', () => {
    const result = applyCommands(
      'ABC',
      empty,
      initial,
      [
        submit('1-0', 'known', 'A', 'buy', '90.00'),
        submit('2-0', 'new', 'A', 'buy', '91.00'),
        submit('3-0', 'new', 'A', 'buy', '91.00'),
      ],
      new Set([oid('known')]),
    );

    expect(result.orders.map((o) => o.id)).toEqual([oid('new')]);
    expect(result.book.bids.map((o) => o.id)).toEqual([oid('new')]);
    expect(result.state.lastCommandId).toBe('3-0');
  });

  it("cancels an owner's resting order and ignores a cancel from anyone else", () => {
    const placed = applyCommands(
      'ABC',
      empty,
      initial,
      [submit('1-0', 'sell-1', 'A', 'sell', '100.00')],
      new Set(),
    );

    const intruder = applyCommands('ABC', placed.book, placed.state, [cancel('2-0', 'sell-1', 'B')], new Set());
    const owner = applyCommands('ABC', placed.book, placed.state, [cancel('2-0', 'sell-1', 'A')], new Set());

    expect(intruder.orders).toEqual([]);
    expect(intruder.book.asks).toHaveLength(1);
    expect(intruder.state.bookSeq).toBe(placed.state.bookSeq);
    expect(owner.book.asks).toHaveLength(0);
    expect(owner.orders).toMatchObject([
      { id: oid('sell-1'), status: 'cancelled', remainingQuantity: '1.00000000' },
    ]);
  });

  it('keeps the filled part of a partially filled order it cancels', () => {
    const result = applyCommands(
      'ABC',
      empty,
      initial,
      [
        submit('1-0', 'sell-1', 'A', 'sell', '100.00', '5.00000000'),
        submit('2-0', 'buy-1', 'B', 'buy', '100.00', '1.00000000'),
        cancel('3-0', 'sell-1', 'A'),
      ],
      new Set(),
    );

    expect(result.orders.find((o) => o.id === oid('sell-1'))).toMatchObject({
      status: 'cancelled',
      quantity: '5.00000000',
      remainingQuantity: '4.00000000',
    });
    expect(result.book.asks).toHaveLength(0);
  });

  it('treats a cancel that arrives after the order filled as a no-op', () => {
    const result = applyCommands(
      'ABC',
      empty,
      initial,
      [
        submit('1-0', 'sell-1', 'A', 'sell', '100.00'),
        submit('2-0', 'buy-1', 'B', 'buy', '100.00'),
        cancel('3-0', 'sell-1', 'A'),
      ],
      new Set(),
    );

    expect(result.orders.find((o) => o.id === oid('sell-1'))?.status).toBe('filled');
  });

  it('skips malformed commands without stopping the stream', () => {
    const malformed = {
      type: 'submit',
      orderId: 'bad',
      ownerId: 'A',
      side: 'buy',
      price: '0.001',
      quantity: '1',
    } as OrderCommand;

    const result = applyCommands(
      'ABC',
      empty,
      initial,
      [{ id: '1-0', command: null }, { id: '2-0', command: malformed }, submit('3-0', 'ok', 'A', 'buy', '1.00')],
      new Set(),
    );

    expect(result.orders.map((o) => o.id)).toEqual([oid('ok')]);
    expect(result.state.lastCommandId).toBe('3-0');
  });

  it('produces identical trades and book when the same stream is replayed', () => {
    const stream = [
      submit('1-0', 'a1', 'A', 'sell', '101.00', '2.00000000'),
      submit('2-0', 'b1', 'B', 'sell', '100.00'),
      submit('3-0', 'c1', 'C', 'buy', '101.00', '2.50000000'),
      cancel('4-0', 'a1', 'A'),
    ];

    const first = applyCommands('ABC', empty, initial, stream, new Set());
    const replay = applyCommands('ABC', empty, initial, stream, new Set());

    expect(replay).toEqual(first);
    expect(first.trades.map((t) => [t.sellOrderId, t.quantity])).toEqual([
      [oid('b1'), '1.00000000'],
      [oid('a1'), '1.50000000'],
    ]);
  });
});
