import { INestApplication } from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { once } from 'events';
import { Server, createServer } from 'http';
import { AddressInfo } from 'net';
import { resolve } from 'path';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { TradeBody, accessToken, createApp, resetState, settle, trade } from './harness';

const FROM = '2026-11-04T10:00:00.000Z';
const TO = '2026-11-04T11:00:00.000Z';

interface EngineRow {
  instrument: string;
  count: number;
  quantity: string;
  notional: string;
}

const ENGINE_IN_PERIOD: EngineRow[] = [
  { instrument: 'ABC', count: 2, quantity: '2.12345678', notional: '7.2358023678' },
  { instrument: 'DEF', count: 1, quantity: '0.00000001', notional: '0.0000000001' },
];

describe('reconciliation', () => {
  let app: INestApplication;
  let engine: Server;
  let engineRows: EngineRow[] | 'down' | 'malformed' | ((from: Date) => EngineRow[]);
  let engineQueries: URLSearchParams[];
  let firstTradeAt: string | null;
  let pendingSince: string | null;
  let progressDown: boolean;
  let engineUrl: string;

  beforeAll(async () => {
    engine = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://engine');
      if (url.pathname.startsWith('/auth/admins/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ admin: true }));
        return;
      }
      engineQueries.push(url.searchParams);
      const progressProbe = url.searchParams.get('from') === new Date(0).toISOString();
      if (engineRows === 'down' || url.pathname !== '/trades/summary' || (progressDown && progressProbe)) {
        res.writeHead(503).end();
        return;
      }
      if (req.headers['x-internal-key'] !== process.env.ENGINE_INTERNAL_KEY) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          firstTradeAt,
          pendingSince,
          instruments:
            engineRows === 'malformed'
              ? [{ instrument: 'ABC', count: '2', quantity: 'lots' }]
              : typeof engineRows === 'function'
                ? engineRows(new Date(url.searchParams.get('from') as string))
                : engineRows,
        }),
      );
    });
    engine.listen(0, '127.0.0.1');
    await once(engine, 'listening');
    engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    process.env.ENGINE_URL = engineUrl;
  });

  afterAll(async () => {
    engine.close();
    await once(engine, 'close');
  });

  beforeEach(async () => {
    await resetState();
    engineRows = [];
    engineQueries = [];
    firstTradeAt = null;
    pendingSince = null;
    progressDown = false;
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const reconcile = (query: Record<string, string> = { from: FROM, to: TO }) =>
    request(app.getHttpServer())
      .get('/admin/reconciliation')
      .set('authorization', `Bearer ${accessToken(randomUUID(), 'admin')}`)
      .query(query);

  const corrupt = (sql: string, parameters: unknown[] = []) =>
    app.get(DataSource).query(sql, parameters);

  async function settleInPeriod(): Promise<TradeBody[]> {
    const trades = [
      trade({ price: '10.01', quantity: '0.12345678', executedAt: '2026-11-04T10:00:00.000Z' }),
      trade({ price: '3.00', quantity: '2', executedAt: '2026-11-04T10:30:00.000Z' }),
      trade({
        instrument: 'DEF',
        price: '0.01',
        quantity: '0.00000001',
        executedAt: '2026-11-04T10:59:59.999Z',
      }),
    ];
    for (const executed of trades) await settle(app, executed).expect(200);
    engineRows = ENGINE_IN_PERIOD;
    return trades;
  }

  it('reports a match when the ledger agrees with itself and with the engine', async () => {
    await settleInPeriod();
    await settle(app, trade({ quantity: '7', executedAt: '2026-11-04T11:00:00.000Z' })).expect(200);
    await settle(app, trade({ quantity: '9', executedAt: '2026-11-04T09:59:59.999Z' })).expect(200);

    const response = await reconcile().expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      period: { from: FROM, to: TO },
      instruments: [
        {
          instrument: 'ABC',
          engine: { count: 2, quantity: '2.12345678', notional: '7.2358023678' },
          ledger: {
            count: 2,
            quantity: '2.12345678',
            notional: '7.2358023678',
            cashMoved: '7.2358023678',
          },
          matches: true,
        },
        {
          instrument: 'DEF',
          engine: { count: 1, quantity: '0.00000001', notional: '0.0000000001' },
          ledger: {
            count: 1,
            quantity: '0.00000001',
            notional: '0.0000000001',
            cashMoved: '0.0000000001',
          },
          matches: true,
        },
      ],
      ledger: {
        unbalancedTransactions: [],
        transactionsWithoutEntries: [],
        accountsOffEntries: [],
        assetsNotBalanced: [],
        tradesOffEntries: [],
      },
    });
    const periods = engineQueries
      .map((query) => [query.get('from'), query.get('to')])
      .filter(([from]) => from !== new Date(0).toISOString());
    expect(periods).toEqual([[FROM, TO]]);
  });

  it('finds a trade the engine executed but the ledger never settled', async () => {
    await settleInPeriod();
    engineRows = [
      { instrument: 'ABC', count: 3, quantity: '3.12345678', notional: '17.2358023678' },
      ENGINE_IN_PERIOD[1],
    ];

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.instruments.map((row: { matches: boolean }) => row.matches)).toEqual([
      false,
      true,
    ]);
  });

  it('finds an instrument the ledger settled but the engine never traded', async () => {
    await settleInPeriod();
    engineRows = ENGINE_IN_PERIOD.slice(0, 1);

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.instruments[1]).toMatchObject({
      instrument: 'DEF',
      engine: { count: 0, quantity: '0.00000000', notional: '0.00' },
      matches: false,
    });
  });

  it('finds an account balance edited by hand', async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `UPDATE accounts SET balance = balance + 1 WHERE "ownerId" = $1 AND asset = 'USD'`,
      [executed.buyerId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.ledger.accountsOffEntries).toEqual([
      expect.objectContaining({
        ownerId: executed.buyerId,
        asset: 'USD',
        balance: '99999.7641976322',
        entries: '99998.7641976322',
      }),
    ]);
    expect(response.body.ledger.assetsNotBalanced).toEqual([{ asset: 'USD', total: '1.00' }]);
  });

  it('finds a ledger entry edited by hand', async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `UPDATE ledger_entries SET amount = amount + 0.5
        WHERE "transactionId" = (SELECT "transactionId" FROM settled_trades WHERE "tradeId" = $1)
          AND asset = 'USD' AND amount > 0`,
      [executed.tradeId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.ledger.unbalancedTransactions).toEqual([
      expect.objectContaining({ asset: 'USD', total: '0.50' }),
    ]);
    expect(response.body.ledger.tradesOffEntries).toEqual([executed.tradeId]);
    expect(response.body.instruments[0]).toMatchObject({
      ledger: { notional: '7.2358023678', cashMoved: '7.7358023678' },
      matches: false,
    });
  });

  it('finds a trade whose money went the wrong way even when the balances were edited to hide it', async () => {
    const [executed] = await settleInPeriod();
    const notional = '1.2358023678';
    const quantity = '0.12345678';
    await corrupt(
      `UPDATE ledger_entries e SET amount = -e.amount
         FROM settled_trades st
        WHERE st."tradeId" = $1 AND e."transactionId" = st."transactionId"`,
      [executed.tradeId],
    );
    await corrupt(
      `UPDATE accounts SET balance = balance + CASE
          WHEN "ownerId" = $1 AND asset = 'USD' THEN 2 * $3::numeric
          WHEN "ownerId" = $2 AND asset = 'USD' THEN -2 * $3::numeric
          WHEN "ownerId" = $1 AND asset = 'ABC' THEN -2 * $4::numeric
          WHEN "ownerId" = $2 AND asset = 'ABC' THEN 2 * $4::numeric
          ELSE 0 END
        WHERE "ownerId" IN ($1, $2)`,
      [executed.buyerId, executed.sellerId, notional, quantity],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.ledger).toEqual({
      unbalancedTransactions: [],
      transactionsWithoutEntries: [],
      accountsOffEntries: [],
      assetsNotBalanced: [],
      tradesOffEntries: [executed.tradeId],
    });
  });

  it('finds a settled trade whose notional was edited by hand', async () => {
    const [executed] = await settleInPeriod();
    await corrupt(`UPDATE settled_trades SET notional = notional * 2 WHERE "tradeId" = $1`, [
      executed.tradeId,
    ]);

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.ledger.tradesOffEntries).toEqual([executed.tradeId]);
  });

  it('finds a trade whose ledger entries were deleted', async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `DELETE FROM ledger_entries
        WHERE "transactionId" = (SELECT "transactionId" FROM settled_trades WHERE "tradeId" = $1)`,
      [executed.tradeId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('mismatch');
    expect(response.body.ledger.transactionsWithoutEntries).toHaveLength(1);
    expect(response.body.ledger.tradesOffEntries).toEqual([executed.tradeId]);
    expect(response.body.ledger.accountsOffEntries).toHaveLength(4);
  });

  it('reports the run as incomplete when the engine cannot be reached', async () => {
    await settleInPeriod();
    engineRows = 'down';

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('incomplete');
    expect(response.body.engineError).toMatch(/503/);
    expect(response.body.instruments.map((row: { engine: unknown }) => row.engine)).toEqual([
      null,
      null,
    ]);
  });

  it('reports the run as incomplete when the engine answers with a malformed summary', async () => {
    await settleInPeriod();
    engineRows = 'malformed';

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe('incomplete');
    expect(response.body.engineError).toBe('Engine returned a malformed trade summary');
  });

  it('starts each default run where the last matching one ended, short of the most recent trades', async () => {
    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect(first.body.status).toBe('ok');
    expect(second.body.period.from).toBe(first.body.period.to);
    expect(Date.now() - new Date(second.body.period.to).getTime()).toBeGreaterThanOrEqual(60000);
  });

  it('never moves its starting point past a minute ago, whatever end it is asked for', async () => {
    const future = new Date(Date.now() + 24 * 3_600_000).toISOString();

    const response = await reconcile({ to: future }).expect(200);

    expect(Date.now() - new Date(response.body.period.to).getTime()).toBeGreaterThanOrEqual(60000);
  });

  it('keeps showing a trade the ledger never settled, however long ago it was executed', async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [{ instrument: 'ABC', count: 1, quantity: '1.00000000', notional: '10.0000000000' }]
        : [];

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect([first.body.status, second.body.status]).toEqual(['mismatch', 'mismatch']);
  });

  it('starts its first run at the first trade either side knows of and checks one day at a time', async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [{ instrument: 'ABC', count: 1, quantity: '1.00000000', notional: '10.0000000000' }]
        : [];

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    const span = (period: { from: string; to: string }) =>
      new Date(period.to).getTime() - new Date(period.from).getTime();
    expect(first.body.period.from).toBe(executedAt.toISOString());
    expect(span(first.body.period)).toBeLessThanOrEqual(24 * 3_600_000);
    expect(second.body.period.from).toBe(first.body.period.to);
  });

  it('moves on after a mismatch and keeps checking the mismatched period until it matches', async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [{ instrument: 'ABC', count: 1, quantity: '1.00000000', notional: '10.0000000000' }]
        : [];

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);
    engineRows = [];
    const third = await reconcile({}).expect(200);
    const fourth = await reconcile({}).expect(200);

    expect(first.body.status).toBe('mismatch');
    expect(second.body.period.from).toBe(first.body.period.to);
    expect(second.body.status).toBe('mismatch');
    expect(second.body.unresolved).toEqual([{ ...first.body.period, status: 'mismatch' }]);
    expect(third.body.unresolved).toEqual([]);
    expect(fourth.body.status).toBe('ok');
  });

  it('does not move on when it could not ask the engine what it has not applied yet', async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    progressDown = true;

    const first = await reconcile({}).expect(200);
    progressDown = false;
    const second = await reconcile({}).expect(200);

    expect(first.body.status).toBe('incomplete');
    expect(second.body.period.from).toBe(first.body.period.from);
  });

  it('keeps a mismatched period even when saving it failed halfway', async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [{ instrument: 'ABC', count: 1, quantity: '1.00000000', notional: '10.0000000000' }]
        : [];
    await corrupt(`ALTER TABLE "reconciliation_unresolved_periods" RENAME TO "unresolved_away"`);
    let failed: { status: number } = { status: 0 };
    try {
      failed = await reconcile({});
    } finally {
      await corrupt(`ALTER TABLE "unresolved_away" RENAME TO "reconciliation_unresolved_periods"`);
    }

    const retried = await reconcile({}).expect(200);

    expect(failed.status).toBe(500);
    expect(retried.body.period.from).toBe(executedAt.toISOString());
    expect(retried.body.status).toBe('mismatch');
  });

  it('says there is nothing new to check while a book has not applied its commands, rather than check the first day again', async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    pendingSince = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect(first.body.period).toEqual({ from: firstTradeAt, to: pendingSince });
    expect(second.body.status).toBe('incomplete');
    expect(second.body.period.from).toBe(pendingSince);
  });

  it('does not check past the oldest command a book has not applied yet', async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    pendingSince = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const first = await reconcile({}).expect(200);
    const asked = await reconcile({ from: firstTradeAt }).expect(200);

    expect(first.body.period).toEqual({ from: firstTradeAt, to: pendingSince });
    expect(asked.body.period.to).toBe(pendingSince);
  });

  it('checks only the ledger activity of the period it was asked about', async () => {
    await settle(app, trade({ executedAt: '2026-11-03T10:00:00.000Z' })).expect(200);
    await corrupt(`UPDATE accounts SET balance = balance + 1 WHERE asset = 'ABC' AND kind = 'user'`);

    const response = await reconcile().expect(200);

    expect(response.body.ledger.accountsOffEntries).toEqual([]);
  });

  it('is open only to admins and rejects a bad period', async () => {
    const asUser = (token: string) =>
      request(app.getHttpServer()).get('/admin/reconciliation').set('authorization', `Bearer ${token}`);
    await request(app.getHttpServer()).get('/admin/reconciliation').expect(401);
    await request(app.getHttpServer())
      .get('/admin/reconciliation')
      .set('x-internal-key', process.env.SETTLEMENT_INTERNAL_KEY as string)
      .expect(401);
    await asUser(accessToken(randomUUID())).expect(403);
    await reconcile({ from: TO, to: FROM }).expect(400);
    await reconcile({ from: 'yesterday' }).expect(400);
  });

  it('runs as a script that exits non-zero on a mismatch', async () => {
    await settleInPeriod();
    const run = async () => {
      const child = spawn(
        process.execPath,
        ['dist/reconciliation/reconcile.js', '--from', FROM, '--to', TO],
        { cwd: resolve(__dirname, '../..'), env: { ...process.env, ENGINE_URL: engineUrl } },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const [code] = await once(child, 'exit');
      return { code, report: JSON.parse(output) };
    };

    const clean = await run();
    await corrupt(`UPDATE accounts SET balance = balance - 1 WHERE "ownerId" = 'system' AND asset = 'ABC'`);
    const broken = await run();

    expect([clean.code, clean.report.status]).toEqual([0, 'ok']);
    expect([broken.code, broken.report.status]).toEqual([1, 'mismatch']);
  });
});
