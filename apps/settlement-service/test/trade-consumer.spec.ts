import { TradeConsumerService } from '../src/consumer/trade-consumer.service';
import { LedgerService, SettlementResult, sameTrade } from '../src/ledger/ledger.service';
import { SettledTrade } from '../src/ledger/entities/settled-trade.entity';
import { TradeConflictError } from '../src/ledger/trade-conflict.error';
import { SettleTradeDto } from '../src/trades/dto/settle-trade.dto';
import { tradeEvents } from '../src/observability/metrics';

const STREAM = 'trades:ABC';

const event = {
  tradeId: '7c1d4c2e-1111-4a5b-8c9d-000000000001',
  instrument: 'ABC',
  buyOrderId: '7c1d4c2e-1111-4a5b-8c9d-000000000002',
  sellOrderId: '7c1d4c2e-1111-4a5b-8c9d-000000000003',
  buyerId: '7c1d4c2e-1111-4a5b-8c9d-000000000004',
  sellerId: '7c1d4c2e-1111-4a5b-8c9d-000000000005',
  price: '10.50',
  quantity: '2',
  executedAt: '2026-11-04T10:00:00.000Z',
};

const fields = (payload: unknown) => ({
  type: 'trade.executed',
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

function consumer(
  settle: (trade: SettleTradeDto) => Promise<SettlementResult>,
  announce: (trade: SettleTradeDto) => Promise<void> = async () => undefined,
) {
  const calls: { command: string; args: unknown[] }[] = [];
  const record =
    (command: string) =>
    async (...args: unknown[]) => {
      calls.push({ command, args });
      return 1;
    };
  const service = new TradeConsumerService({ settle, announce } as unknown as LedgerService);
  Object.assign(service as unknown as Record<string, unknown>, {
    client: { xack: record('xack'), xadd: record('xadd') },
  });
  const handle = (raw: Record<string, string>) =>
    (
      service as unknown as {
        handle: (s: string, id: string, f: Record<string, string>, d: number) => Promise<void>;
      }
    ).handle(STREAM, '1-0', raw, 1);
  const pollOnce = (entries: [string, Record<string, string>][]) => {
    Object.assign(service as unknown as Record<string, unknown>, {
      running: true,
      reader: {
        xreadgroup: async () => [
          [STREAM, entries.map(([id, raw]) => [id, Object.entries(raw).flat()])],
        ],
      },
    });
    return (service as unknown as { poll: () => Promise<void> }).poll();
  };
  return { handle, pollOnce, calls, commands: () => calls.map((call) => call.command) };
}

const counted = async (result: string) =>
  (await tradeEvents.get()).values.find((value) => value.labels.result === result)?.value ?? 0;

describe('trade event consumer', () => {
  beforeEach(() => tradeEvents.reset());

  it('counts a trade as settled once although announcing its wallets failed the first time', async () => {
    let deliveries = 0;
    let announcements = 0;
    const { handle, commands } = consumer(
      async () => (++deliveries === 1 ? 'settled' : 'duplicate'),
      async () => {
        announcements += 1;
        if (announcements === 1) throw new Error('Connection is closed.');
      },
    );

    await expect(handle(fields(event))).rejects.toThrow(/will retry/);
    await handle(fields(event));

    expect(commands()).toEqual(['xack']);
    expect(await counted('settled')).toBe(1);
    expect(await counted('duplicate')).toBe(1);
    expect(await counted('failed')).toBe(0);
  });

  it('keeps settling the rest of a batch when one trade cannot be settled yet', async () => {
    const other = { ...event, tradeId: '7c1d4c2e-1111-4a5b-8c9d-000000000009' };
    const { pollOnce, calls } = consumer(async (trade) => {
      if (trade.tradeId === event.tradeId) throw new Error('Connection terminated unexpectedly');
      return 'settled';
    });

    await expect(
      pollOnce([
        ['1-0', fields(event)],
        ['2-0', fields(other)],
      ]),
    ).rejects.toThrow(/will retry/);

    expect(calls.filter((call) => call.command === 'xack').map((call) => call.args[2])).toEqual(['2-0']);
  });

  it('acknowledges a trade once the ledger settled it', async () => {
    const settled: string[] = [];
    const { handle, calls, commands } = consumer(async (trade) => {
      settled.push(trade.tradeId);
      return 'settled';
    });

    await handle(fields(event));

    expect(settled).toEqual([event.tradeId]);
    expect(commands()).toEqual(['xack']);
    expect(calls[0].args).toEqual([STREAM, 'settlement', '1-0']);
  });

  it('acknowledges a redelivered trade the ledger reports as a duplicate', async () => {
    let settlements = 0;
    const { handle, commands } = consumer(async () => (++settlements === 1 ? 'settled' : 'duplicate'));

    await handle(fields(event));
    await handle(fields(event));

    expect(settlements).toBe(2);
    expect(commands()).toEqual(['xack', 'xack']);
  });

  it('dead-letters a trade id that comes back with different details', async () => {
    const { handle, commands, calls } = consumer(async () => {
      throw new TradeConflictError(event.tradeId);
    });

    await handle(fields({ ...event, price: '99.00' }));

    expect(commands()).toEqual(['xadd', 'xack']);
    expect(calls[0].args[0]).toBe('settlement:dead-letter');
  });

  it('dead-letters a malformed event without touching the ledger', async () => {
    let touched = false;
    const { handle, commands } = consumer(async () => {
      touched = true;
      return 'settled';
    });

    await handle(fields('{not json'));
    await handle(fields({ ...event, quantity: '0' }));
    await handle({ type: 'something.else', payload: JSON.stringify(event) });

    expect(touched).toBe(false);
    expect(commands()).toEqual(['xadd', 'xack', 'xadd', 'xack', 'xadd', 'xack']);
  });

  it('leaves a trade unacknowledged for redelivery when the ledger fails for a moment', async () => {
    const { handle, commands } = consumer(async () => {
      throw new Error('Connection terminated unexpectedly');
    });

    await expect(handle(fields(event))).rejects.toThrow(/will retry/);

    expect(commands()).toEqual([]);
  });
});

describe('recognising a redelivered trade', () => {
  const stored = {
    ...event,
    price: '10.50',
    quantity: '2.00000000',
    executedAt: new Date(event.executedAt),
  } as unknown as SettledTrade;

  it('treats the same trade written with different decimal padding as the same', () => {
    expect(sameTrade(stored, { ...event, quantity: '2.0' } as SettleTradeDto)).toBe(true);
  });

  it('treats any change of terms or parties as a different trade', () => {
    const changes: Partial<SettleTradeDto>[] = [
      { price: '10.51' },
      { quantity: '2.00000001' },
      { buyerId: event.sellerId, sellerId: event.buyerId },
      { instrument: 'DEF' },
      { executedAt: '2026-11-04T10:00:00.001Z' },
    ];

    for (const change of changes) {
      expect(sameTrade(stored, { ...event, ...change } as SettleTradeDto)).toBe(false);
    }
  });
});
