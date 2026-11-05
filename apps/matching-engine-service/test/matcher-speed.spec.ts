import { applyCommands, EngineState } from '../src/orders/engine/apply-commands';
import { StreamCommand } from '../src/orders/engine/order-command';
import { uuidV5 } from '../src/common/uuid';

describe('matching on a deep book', () => {
  it('rests thousands of orders one by one without sorting the whole book for each', () => {
    const commands: StreamCommand[] = Array.from({ length: 6_000 }, (_, i) => ({
      id: `${1_700_000_000_000 + i}-0`,
      command: {
        type: 'submit',
        orderId: uuidV5(`deep:${i}`),
        ownerId: 'maker',
        side: i % 2 === 0 ? 'buy' : 'sell',
        price: i % 2 === 0 ? `${(1000 - (i % 997)).toFixed(2)}` : `${(2000 + (i % 991)).toFixed(2)}`,
        quantity: '1',
      },
    }));
    const state: EngineState = { lastCommandId: '0-0', orderSeq: 0n, tradeSeq: 0n, bookSeq: 0n };

    const startedAt = performance.now();
    const result = applyCommands('ABC', { bids: [], asks: [] }, state, commands, new Set());
    const elapsedMs = performance.now() - startedAt;

    expect(result.book.bids).toHaveLength(3_000);
    expect(result.book.asks).toHaveLength(3_000);
    expect(elapsedMs).toBeLessThan(1_500);
  });
});
