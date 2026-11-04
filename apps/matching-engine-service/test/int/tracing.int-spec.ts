import Redis from 'ioredis';
import { tradeStreamKey } from '../../src/outbox/trade-event';
import { EngineProcess, api, startEngine, stopEngine, waitForOwner } from './engines';
import { TestUser, eventually, resetState } from './harness';

interface LogLine {
  level: string;
  service: string;
  context?: string;
  traceId?: string;
  message: string;
}

const linesOf = (engine: EngineProcess): LogLine[] =>
  engine.logs
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));

describe('trace ids through the engine', () => {
  const engines: EngineProcess[] = [];

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => stopEngine(engine, 'SIGKILL')));
  });

  it('follows one order from the request to the published trade event under its trace id', async () => {
    const engine = await startEngine('engine-trace', 4311);
    engines.push(engine);
    await waitForOwner('ABC', 'engine-trace');
    const client = api(engine);
    const [seller, buyer] = [await client.register(), await client.register()];
    const place = (user: TestUser, side: 'buy' | 'sell', traceId: string) =>
      fetch(`${engine.url}/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${user.token}`,
          'idempotency-key': traceId,
          'x-request-id': traceId,
        },
        body: JSON.stringify({ instrument: 'ABC', side, price: '10.00', quantity: '1' }),
      });

    await place(seller, 'sell', 'trace-sell-1');
    const response = await place(buyer, 'buy', 'trace-buy-1');

    expect(response.headers.get('x-request-id')).toBe('trace-buy-1');
    await eventually(async () => {
      const messages = linesOf(engine)
        .filter((line) => line.traceId === 'trace-buy-1')
        .map((line) => line.message);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^POST \/orders 202 /),
          expect.stringMatching(/^Applied submit .* filled$/),
          expect.stringMatching(/^Trade .* executed 1\.00000000 @ 10\.00$/),
          expect.stringMatching(/^Published trade\.executed .* to trades:ABC$/),
        ]),
      );
    });
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    const [[, fields]] = await redis.xrange(tradeStreamKey('ABC'), '-', '+');
    await redis.quit();
    expect(JSON.parse(fields[fields.indexOf('payload') + 1]).traceId).toBe('trace-buy-1');
    expect(linesOf(engine).every((line) => line.service === 'matching-engine-service')).toBe(true);
  });

  it('gives a request without a usable trace id a fresh one', async () => {
    const engine = await startEngine('engine-trace', 4312);
    engines.push(engine);

    const response = await fetch(`${engine.url}/orders/book?instrument=ABC`, {
      headers: { 'x-request-id': 'not a valid id <script>' },
    });

    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
