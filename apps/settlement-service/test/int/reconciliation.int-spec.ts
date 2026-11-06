import { INestApplication } from "@nestjs/common";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { once } from "events";
import { Server, createServer } from "http";
import { AddressInfo } from "net";
import { resolve } from "path";
import request from "supertest";
import { DataSource } from "typeorm";
import { ReconciliationService } from "../../src/reconciliation/reconciliation.service";
import { RECONCILIATION_DATABASE } from "../../src/reconciliation/reconciliation-database";
import {
  GROUP,
  TRADE_STREAM,
  TradeBody,
  accessToken,
  createApp,
  eventually,
  publishTrade,
  range,
  redisClient,
  resetState,
  settle,
  trade,
} from "./harness";

const FROM = "2026-11-04T10:00:00.000Z";
const TO = "2026-11-04T11:00:00.000Z";

interface EngineRow {
  instrument: string;
  count: number;
  quantity: string;
  notional: string;
}

const ENGINE_IN_PERIOD: EngineRow[] = [
  {
    instrument: "ABC",
    count: 2,
    quantity: "2.12345678",
    notional: "7.2358023678",
  },
  {
    instrument: "DEF",
    count: 1,
    quantity: "0.00000001",
    notional: "0.0000000001",
  },
];

describe("reconciliation", () => {
  let app: INestApplication;
  let engine: Server;
  let engineRows:
    EngineRow[] | "down" | "malformed" | ((from: Date) => EngineRow[]);
  let engineQueries: URLSearchParams[];
  let firstTradeAt: string | null;
  let pendingSince: string | null;
  let progressDown: boolean;
  let beforeProgress: (() => Promise<void>) | null;
  let engineUrl: string;

  beforeAll(async () => {
    engine = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://engine");
      if (url.pathname.startsWith("/auth/admins/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ admin: true }));
        return;
      }
      engineQueries.push(url.searchParams);
      const progressProbe =
        url.searchParams.get("from") === new Date(0).toISOString();
      if (progressProbe && beforeProgress) await beforeProgress();
      if (
        engineRows === "down" ||
        url.pathname !== "/trades/summary" ||
        (progressDown && progressProbe)
      ) {
        res.writeHead(503).end();
        return;
      }
      if (req.headers["x-internal-key"] !== process.env.ENGINE_INTERNAL_KEY) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          firstTradeAt,
          pendingSince,
          instruments:
            engineRows === "malformed"
              ? [{ instrument: "ABC", count: "2", quantity: "lots" }]
              : typeof engineRows === "function"
                ? engineRows(new Date(url.searchParams.get("from") as string))
                : engineRows,
        }),
      );
    });
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    engineUrl = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    process.env.ENGINE_URL = engineUrl;
  });

  afterAll(async () => {
    engine.close();
    await once(engine, "close");
  });

  beforeEach(async () => {
    await resetState();
    engineRows = [];
    engineQueries = [];
    firstTradeAt = null;
    pendingSince = null;
    progressDown = false;
    beforeProgress = null;
    app = await createApp();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const reconcile = (query: Record<string, string> = { from: FROM, to: TO }) =>
    request(app.getHttpServer())
      .get("/admin/reconciliation")
      .set("authorization", `Bearer ${accessToken(randomUUID(), "admin")}`)
      .query(query);

  async function restartWith(env: Record<string, string>): Promise<void> {
    await app.close();
    const saved = Object.fromEntries(
      Object.keys(env).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, env);
    try {
      app = await createApp();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const corrupt = (sql: string, parameters: unknown[] = []) =>
    app.get(DataSource).query(sql, parameters);

  async function settleInPeriod(): Promise<TradeBody[]> {
    const trades = [
      trade({
        price: "10.01",
        quantity: "0.12345678",
        executedAt: "2026-11-04T10:00:00.000Z",
      }),
      trade({
        price: "3.00",
        quantity: "2",
        executedAt: "2026-11-04T10:30:00.000Z",
      }),
      trade({
        instrument: "DEF",
        price: "0.01",
        quantity: "0.00000001",
        executedAt: "2026-11-04T10:59:59.999Z",
      }),
    ];
    for (const executed of trades) await settle(app, executed).expect(200);
    engineRows = ENGINE_IN_PERIOD;
    return trades;
  }

  it("reports a match when the ledger agrees with itself and with the engine", async () => {
    await settleInPeriod();
    await settle(
      app,
      trade({ quantity: "7", executedAt: "2026-11-04T11:00:00.000Z" }),
    ).expect(200);
    await settle(
      app,
      trade({ quantity: "9", executedAt: "2026-11-04T09:59:59.999Z" }),
    ).expect(200);

    const response = await reconcile().expect(200);

    expect(response.body).toEqual({
      status: "ok",
      period: { from: FROM, to: TO },
      instruments: [
        {
          instrument: "ABC",
          engine: {
            count: 2,
            quantity: "2.12345678",
            notional: "7.2358023678",
          },
          ledger: {
            count: 2,
            quantity: "2.12345678",
            notional: "7.2358023678",
            cashMoved: "7.2358023678",
          },
          matches: true,
        },
        {
          instrument: "DEF",
          engine: {
            count: 1,
            quantity: "0.00000001",
            notional: "0.0000000001",
          },
          ledger: {
            count: 1,
            quantity: "0.00000001",
            notional: "0.0000000001",
            cashMoved: "0.0000000001",
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
      .map((query) => [query.get("from"), query.get("to")])
      .filter(([from]) => from !== new Date(0).toISOString());
    expect(periods).toEqual([[FROM, TO]]);
  });

  it("finds a trade the engine executed but the ledger never settled", async () => {
    await settleInPeriod();
    engineRows = [
      {
        instrument: "ABC",
        count: 3,
        quantity: "3.12345678",
        notional: "17.2358023678",
      },
      ENGINE_IN_PERIOD[1],
    ];

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(
      response.body.instruments.map((row: { matches: boolean }) => row.matches),
    ).toEqual([false, true]);
  });

  it("finds an instrument the ledger settled but the engine never traded", async () => {
    await settleInPeriod();
    engineRows = ENGINE_IN_PERIOD.slice(0, 1);

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(response.body.instruments[1]).toMatchObject({
      instrument: "DEF",
      engine: { count: 0, quantity: "0.00000000", notional: "0.00" },
      matches: false,
    });
  });

  it("finds an account balance edited by hand", async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `UPDATE accounts SET balance = balance + 1 WHERE "ownerId" = $1 AND asset = 'USD'`,
      [executed.buyerId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(response.body.ledger.accountsOffEntries).toEqual([
      expect.objectContaining({
        ownerId: executed.buyerId,
        asset: "USD",
        balance: "99999.7641976322",
        entries: "99998.7641976322",
      }),
    ]);
    expect(response.body.ledger.assetsNotBalanced).toEqual([
      { asset: "USD", total: "1.00" },
    ]);
  });

  it("finds a ledger entry edited by hand", async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `UPDATE ledger_entries SET amount = amount + 0.5
        WHERE "transactionId" = (SELECT "transactionId" FROM settled_trades WHERE "tradeId" = $1)
          AND asset = 'USD' AND amount > 0`,
      [executed.tradeId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(response.body.ledger.unbalancedTransactions).toEqual([
      expect.objectContaining({ asset: "USD", total: "0.50" }),
    ]);
    expect(response.body.ledger.tradesOffEntries).toEqual([executed.tradeId]);
    expect(response.body.instruments[0]).toMatchObject({
      ledger: { notional: "7.2358023678", cashMoved: "7.7358023678" },
      matches: false,
    });
  });

  it("finds a trade whose money went the wrong way even when the balances were edited to hide it", async () => {
    const [executed] = await settleInPeriod();
    const notional = "1.2358023678";
    const quantity = "0.12345678";
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

    expect(response.body.status).toBe("mismatch");
    expect(response.body.ledger).toEqual({
      unbalancedTransactions: [],
      transactionsWithoutEntries: [],
      accountsOffEntries: [],
      assetsNotBalanced: [],
      tradesOffEntries: [executed.tradeId],
    });
  });

  it("finds a settled trade whose notional was edited by hand", async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `UPDATE settled_trades SET notional = notional * 2 WHERE "tradeId" = $1`,
      [executed.tradeId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(response.body.ledger.tradesOffEntries).toEqual([executed.tradeId]);
  });

  it("finds a trade whose ledger entries were deleted", async () => {
    const [executed] = await settleInPeriod();
    await corrupt(
      `DELETE FROM ledger_entries
        WHERE "transactionId" = (SELECT "transactionId" FROM settled_trades WHERE "tradeId" = $1)`,
      [executed.tradeId],
    );

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(response.body.ledger.transactionsWithoutEntries).toHaveLength(1);
    expect(response.body.ledger.tradesOffEntries).toEqual([executed.tradeId]);
    expect(response.body.ledger.accountsOffEntries).toHaveLength(4);
  });

  it("reports the run as incomplete when the engine cannot be reached", async () => {
    await settleInPeriod();
    engineRows = "down";

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("incomplete");
    expect(response.body.engineError).toMatch(/503/);
    expect(
      response.body.instruments.map((row: { engine: unknown }) => row.engine),
    ).toEqual([null, null]);
  });

  it("reports the run as incomplete when the engine answers with a malformed summary", async () => {
    await settleInPeriod();
    engineRows = "malformed";

    const response = await reconcile().expect(200);

    expect(response.body.status).toBe("incomplete");
    expect(response.body.engineError).toBe(
      "Engine returned a malformed trade summary",
    );
  });

  it("starts each default run where the last matching one ended, short of the most recent trades", async () => {
    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect(first.body.status).toBe("ok");
    expect(second.body.period.from).toBe(first.body.period.to);
    expect(
      Date.now() - new Date(second.body.period.to).getTime(),
    ).toBeGreaterThanOrEqual(60000);
  });

  it("never moves its starting point past a minute ago, whatever end it is asked for", async () => {
    const future = new Date(Date.now() + 24 * 3_600_000).toISOString();

    const response = await reconcile({ to: future }).expect(200);

    expect(
      Date.now() - new Date(response.body.period.to).getTime(),
    ).toBeGreaterThanOrEqual(60000);
  });

  it("keeps showing a trade the ledger never settled, however long ago it was executed", async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [
            {
              instrument: "ABC",
              count: 1,
              quantity: "1.00000000",
              notional: "10.0000000000",
            },
          ]
        : [];

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect([first.body.status, second.body.status]).toEqual([
      "mismatch",
      "mismatch",
    ]);
  });

  it("starts its first run at the first trade either side knows of and checks one day at a time", async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [
            {
              instrument: "ABC",
              count: 1,
              quantity: "1.00000000",
              notional: "10.0000000000",
            },
          ]
        : [];

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    const span = (period: { from: string; to: string }) =>
      new Date(period.to).getTime() - new Date(period.from).getTime();
    expect(first.body.period.from).toBe(executedAt.toISOString());
    expect(span(first.body.period)).toBeLessThanOrEqual(24 * 3_600_000);
    expect(second.body.period.from).toBe(first.body.period.to);
  });

  it("moves on after a mismatch and keeps checking the mismatched period until it matches", async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [
            {
              instrument: "ABC",
              count: 1,
              quantity: "1.00000000",
              notional: "10.0000000000",
            },
          ]
        : [];

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);
    engineRows = [];
    const third = await reconcile({}).expect(200);
    const fourth = await reconcile({}).expect(200);

    expect(first.body.status).toBe("mismatch");
    expect(second.body.period.from).toBe(first.body.period.to);
    expect(second.body.status).toBe("mismatch");
    expect(second.body.unresolved).toEqual([
      { ...first.body.period, status: "mismatch", rechecked: true },
    ]);
    expect(third.body.unresolved).toEqual([]);
    expect(fourth.body.status).toBe("ok");
  });

  it("does not move on when it could not ask the engine what it has not applied yet", async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    progressDown = true;

    const first = await reconcile({}).expect(200);
    progressDown = false;
    const second = await reconcile({}).expect(200);

    expect(first.body.status).toBe("incomplete");
    expect(second.body.period.from).toBe(firstTradeAt);
  });

  it("keeps a mismatched period even when saving it failed halfway", async () => {
    const executedAt = new Date(Date.now() - 30 * 3_600_000);
    firstTradeAt = executedAt.toISOString();
    engineRows = (from) =>
      from <= executedAt
        ? [
            {
              instrument: "ABC",
              count: 1,
              quantity: "1.00000000",
              notional: "10.0000000000",
            },
          ]
        : [];
    await corrupt(
      `ALTER TABLE "reconciliation_unresolved_periods" RENAME TO "unresolved_away"`,
    );
    let failed: { status: number } = { status: 0 };
    try {
      failed = await reconcile({});
    } finally {
      await corrupt(
        `ALTER TABLE "unresolved_away" RENAME TO "reconciliation_unresolved_periods"`,
      );
    }

    const retried = await reconcile({}).expect(200);

    expect(failed.status).toBe(500);
    expect(retried.body.period.from).toBe(executedAt.toISOString());
    expect(retried.body.status).toBe("mismatch");
  });

  it("says there is nothing new to check while a book has not applied its commands, rather than check the first day again", async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    pendingSince = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect(first.body.period).toEqual({ from: firstTradeAt, to: pendingSince });
    expect(second.body.status).toBe("incomplete");
    expect(second.body.period.from).toBe(pendingSince);
  });

  it("lists every period that still does not match, not only the ones it had time to check again", async () => {
    const cutoff = new Date(Date.now() - 100 * 24 * 3_600_000);
    engineRows = (from) =>
      from < cutoff
        ? [
            {
              instrument: "ABC",
              count: 1,
              quantity: "1.00000000",
              notional: "10.0000000000",
            },
          ]
        : [];
    for (let day = 0; day < 12; day += 1) {
      const from = new Date(cutoff.getTime() - (day + 1) * 24 * 3_600_000);
      await corrupt(
        `INSERT INTO "reconciliation_unresolved_periods" ("from", "to") VALUES ($1, $2)`,
        [from, new Date(from.getTime() + 3_600_000)],
      );
    }

    const response = await reconcile({}).expect(200);

    expect(response.body.status).toBe("mismatch");
    expect(response.body.unresolvedTotal).toBe(12);
    expect(response.body.unresolved).toHaveLength(12);
    expect(
      response.body.unresolved.filter(
        (row: { rechecked: boolean }) => row.rechecked,
      ),
    ).toHaveLength(10);
  });

  it("does not check past a trade settlement has not settled yet", async () => {
    await app.close();
    const enabled = process.env.CONSUMER_ENABLED;
    process.env.CONSUMER_ENABLED = "false";
    try {
      app = await createApp();
    } finally {
      process.env.CONSUMER_ENABLED = enabled;
    }
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const executedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const redis = redisClient();
    await publishTrade(redis, trade({ executedAt }));
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.period).toEqual({
      from: firstTradeAt,
      to: executedAt,
    });
  });

  it("rechecks the periods it checked longest ago, so newer ones that match again are dropped while older ones never do", async () => {
    const cutoff = new Date(Date.now() - 100 * 24 * 3_600_000);
    engineRows = (from) =>
      from < cutoff
        ? [
            {
              instrument: "ABC",
              count: 1,
              quantity: "1.00000000",
              notional: "10.0000000000",
            },
          ]
        : [];
    const day = 24 * 3_600_000;
    const starts = [
      ...range(10).map((n) => cutoff.getTime() - (n + 2) * day),
      cutoff.getTime() + day,
      cutoff.getTime() + 2 * day,
    ];
    for (const start of starts) {
      await corrupt(
        `INSERT INTO "reconciliation_unresolved_periods" ("from", "to") VALUES ($1, $2)`,
        [new Date(start), new Date(start + 3_600_000)],
      );
    }

    const first = await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect(first.body.unresolvedTotal).toBe(12);
    expect(second.body.unresolvedTotal).toBe(10);
    expect(
      second.body.unresolved.every(
        (row: { from: string }) => new Date(row.from) < cutoff,
      ),
    ).toBe(true);
  });

  it("reads what settlement has not settled only after the engine answered, so a trade published meanwhile is not missed", async () => {
    await restartWith({ CONSUMER_ENABLED: "false" });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const executedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const redis = redisClient();
    beforeProgress = async () => {
      await pause(300);
      await publishTrade(redis, trade({ executedAt }));
    };

    const response = await reconcile({}).expect(200);
    await redis.quit();

    expect(response.body.period).toEqual({
      from: firstTradeAt,
      to: executedAt,
    });
  });

  it("ends a period where it started asking what is still on the way, not where the answers came back", async () => {
    await restartWith({ RECONCILIATION_LAG_MS: "0" });
    beforeProgress = () => pause(400);
    const from = new Date(Date.now() - 3_600_000).toISOString();

    const asked = Date.now();
    const response = await reconcile({ from }).expect(200);

    expect(new Date(response.body.period.to).getTime()).toBeLessThan(
      asked + 200,
    );
  });

  it("runs one default check at a time, however many pages ask for it", async () => {
    beforeProgress = () => pause(200);

    const [first, second] = await Promise.all([
      reconcile({}).expect(200),
      reconcile({}).expect(200),
    ]);

    expect(second.body).toEqual(first.body);
    expect(
      engineQueries.filter(
        (query) => query.get("from") === new Date(0).toISOString(),
      ),
    ).toHaveLength(1);
  });

  it("says it is settlement that is behind when there is nothing new to check because of it", async () => {
    await restartWith({ CONSUMER_ENABLED: "false" });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const executedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const redis = redisClient();
    await publishTrade(redis, trade({ executedAt }));
    await redis.quit();

    await reconcile({}).expect(200);
    const second = await reconcile({}).expect(200);

    expect(second.body.status).toBe("incomplete");
    expect(second.body.engineError).toMatch(/settlement has not settled/);
  });

  it("says why there is nothing new to check when it could not read what settlement has not settled", async () => {
    await restartWith({ CONSUMER_ENABLED: "false" });
    await corrupt(
      `INSERT INTO "reconciliation_checkpoints" ("name", "reconciledUntil") VALUES ('default', now())`,
    );
    const redis = redisClient();
    await redis.set("trades:ABC", "not a stream");
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.status).toBe("incomplete");
    expect(response.body.engineError).toMatch(
      /Could not read which trades settlement has not settled/,
    );
  });

  it("answers a check that starts after what is still on the way with the reason instead of an error", async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    pendingSince = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const response = await reconcile({
      from: new Date(Date.now() - 3_600_000).toISOString(),
    }).expect(200);

    expect(response.body.status).toBe("incomplete");
    expect(response.body.engineError).toMatch(/engine has not applied/);
  });

  it("does not check past the trade settlement has waited longest for, whatever order the trades were published in", async () => {
    await restartWith({ CONSUMER_ENABLED: "false" });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const older = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const redis = redisClient();
    await publishTrade(
      redis,
      trade({ executedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    );
    await publishTrade(redis, trade({ executedAt: older }));
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.period.to).toBe(older);
  });

  it("does not check past a delivered trade settlement has not acknowledged, even if it is not the first one delivered", async () => {
    await restartWith({ CONSUMER_ENABLED: "false" });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const older = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const redis = redisClient();
    await redis
      .xgroup("CREATE", TRADE_STREAM, GROUP, "0", "MKSTREAM")
      .catch(() => undefined);
    await publishTrade(
      redis,
      trade({ executedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    );
    await publishTrade(redis, trade({ executedAt: older }));
    await redis.xreadgroup(
      "GROUP",
      GROUP,
      "someone",
      "COUNT",
      10,
      "STREAMS",
      TRADE_STREAM,
      ">",
    );
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.period.to).toBe(older);
  });

  it("reads only the trades settlement has not finished, not those it acknowledged after a stalled one", async () => {
    await restartWith({
      CONSUMER_ENABLED: "false",
      RECONCILIATION_BACKLOG_LIMIT: "5",
    });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const stalled = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const redis = redisClient();
    await redis
      .xgroup("CREATE", TRADE_STREAM, GROUP, "0", "MKSTREAM")
      .catch(() => undefined);
    await publishTrade(redis, trade({ executedAt: stalled }));
    await redis.xreadgroup("GROUP", GROUP, "stalled", "COUNT", 1, "STREAMS", TRADE_STREAM, ">");
    for (let n = 0; n < 10; n += 1) await publishTrade(redis, trade());
    const done = (await redis.xreadgroup(
      "GROUP",
      GROUP,
      "busy",
      "COUNT",
      100,
      "STREAMS",
      TRADE_STREAM,
      ">",
    )) as [string, [string, string[]][]][];
    await redis.xack(TRADE_STREAM, GROUP, ...done[0][1].map(([id]) => id));
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.period.to).toBe(stalled);
  });

  it("stops reading a settlement backlog past its limit and reports the run as incomplete", async () => {
    await restartWith({
      CONSUMER_ENABLED: "false",
      RECONCILIATION_BACKLOG_LIMIT: "5",
    });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const redis = redisClient();
    for (let n = 0; n < 10; n += 1) await publishTrade(redis, trade());
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.status).toBe("incomplete");
    expect(response.body.engineError).toMatch(
      /more than 5 trades in trades:ABC are waiting for settlement/,
    );
  });

  it("reports a period with trades it could not see waiting in settlement as incomplete, not as a mismatch", async () => {
    await restartWith({
      CONSUMER_ENABLED: "false",
      RECONCILIATION_BACKLOG_LIMIT: "5",
    });
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    engineRows = [
      {
        instrument: "ABC",
        count: 1,
        quantity: "1.00000000",
        notional: "10.0000000000",
      },
    ];
    const redis = redisClient();
    for (let n = 0; n < 10; n += 1)
      await publishTrade(redis, trade({ executedAt: firstTradeAt }));
    await redis.quit();

    const response = await reconcile({}).expect(200);

    expect(response.body.status).toBe("incomplete");
  });

  it("keeps a period that could not be checked again as a mismatch and moves on to the others", async () => {
    engineRows = "down";
    const day = 24 * 3_600_000;
    const start = Date.now() - 200 * day;
    for (let n = 0; n < 12; n += 1) {
      await corrupt(
        `INSERT INTO "reconciliation_unresolved_periods" ("from", "to") VALUES ($1, $2)`,
        [new Date(start + n * day), new Date(start + n * day + 3_600_000)],
      );
    }

    const response = await reconcile({}).expect(200);
    const [{ checked }] = await corrupt(
      `SELECT COUNT("checkedAt")::int AS "checked" FROM "reconciliation_unresolved_periods"`,
    );

    expect(response.body.status).toBe("mismatch");
    expect(
      response.body.unresolved.every(
        (row: { status: string }) => row.status === "mismatch",
      ),
    ).toBe(true);
    expect(checked).toBe(10);
  });

  it("keeps going when checking one unresolved period again fails, and checks the others first next time", async () => {
    const day = 24 * 3_600_000;
    const broken = new Date(Date.now() - 300 * day);
    await corrupt(
      `INSERT INTO "reconciliation_unresolved_periods" ("from", "to") VALUES ($1, $2)`,
      [broken, new Date(broken.getTime() + 3_600_000)],
    );
    const service = app.get(ReconciliationService);
    const original = service.reconcile.bind(service);
    jest
      .spyOn(service, "reconcile")
      .mockImplementation((from: Date, to: Date) =>
        from.getTime() === broken.getTime()
          ? Promise.reject(new Error("canceling statement due to statement timeout"))
          : original(from, to),
      );

    const response = await reconcile({}).expect(200);
    const [{ checkedAt }] = await corrupt(
      `SELECT "checkedAt" FROM "reconciliation_unresolved_periods"`,
    );

    expect(response.body.unresolvedTotal).toBe(1);
    expect(checkedAt).not.toBeNull();
  });

  const failQueries = (pattern: RegExp, message = "could not write") => {
    const database = app.get<DataSource>(RECONCILIATION_DATABASE);
    const query = database.query.bind(database);
    jest
      .spyOn(database, "query")
      .mockImplementation((sql: string, parameters?: unknown[]) =>
        pattern.test(sql) ? Promise.reject(new Error(message)) : query(sql, parameters),
      );
  };

  const unresolvedPeriod = async () => {
    const from = new Date(Date.now() - 400 * 24 * 3_600_000);
    const to = new Date(from.getTime() + 3_600_000);
    await corrupt(
      `INSERT INTO "reconciliation_unresolved_periods" ("from", "to") VALUES ($1, $2)`,
      [from, to],
    );
    return { from, to };
  };

  it("does not call a period that matches again a mismatch when it could not be taken off the list", async () => {
    await unresolvedPeriod();
    failQueries(/^DELETE FROM "reconciliation_unresolved_periods"/);

    const response = await reconcile({}).expect(200);

    expect(response.body.unresolved).toEqual([]);
    expect(response.body.unresolvedTotal).toBe(0);
    expect(response.body.status).toBe("incomplete");
    expect(response.body.recheckError).toMatch(/matches now, but could not be taken off/);
  });

  it("counts the rest of the list correctly when a removal went through but its answer was lost", async () => {
    const period = await unresolvedPeriod();
    const broken = new Date(period.from.getTime() - 24 * 3_600_000);
    await corrupt(
      `INSERT INTO "reconciliation_unresolved_periods" ("from", "to") VALUES ($1, $2)`,
      [broken, new Date(broken.getTime() + 3_600_000)],
    );
    engineRows = (from) =>
      from.getTime() === broken.getTime()
        ? [{ instrument: "ABC", count: 1, quantity: "1.00000000", notional: "10.0000000000" }]
        : [];
    const database = app.get<DataSource>(RECONCILIATION_DATABASE);
    const query = database.query.bind(database);
    jest
      .spyOn(database, "query")
      .mockImplementation(async (sql: string, parameters?: unknown[]) => {
        const result = await query(sql, parameters);
        if (/^DELETE FROM "reconciliation_unresolved_periods"/.test(sql)) {
          throw new Error("Query read timeout: Postgres did not answer within 605000 ms");
        }
        return result;
      });

    const response = await reconcile({}).expect(200);

    expect(response.body.unresolved).toHaveLength(1);
    expect(response.body.unresolvedTotal).toBe(1);
    expect(response.body.recheckError).toMatch(/could not be taken off/);
  });

  it("stops rechecking and says so when it cannot note which period it checks, instead of keeping that period first", async () => {
    const period = await unresolvedPeriod();
    const service = app.get(ReconciliationService);
    const checked = jest.spyOn(service, "reconcile");
    failQueries(/^UPDATE "reconciliation_unresolved_periods"/);

    const response = await reconcile({}).expect(200);

    expect(
      checked.mock.calls.some(([from]) => from.getTime() === period.from.getTime()),
    ).toBe(false);
    expect(response.body.recheckError).toMatch(/could not note that/);
    expect(response.body.unresolved).toEqual([
      { from: period.from.toISOString(), to: period.to.toISOString(), status: "mismatch", rechecked: false },
    ]);
  });

  it("lets the next period check start only once every query of a failed one has finished", async () => {
    const database = app.get<DataSource>(RECONCILIATION_DATABASE);
    const query = database.query.bind(database);
    let running = 0;
    jest
      .spyOn(database, "query")
      .mockImplementation(async (sql: string, parameters?: unknown[]) => {
        if (/HAVING SUM\("balance"\)/.test(sql)) throw new Error("canceling statement due to statement timeout");
        running += 1;
        try {
          await pause(300);
          return await query(sql, parameters);
        } finally {
          running -= 1;
        }
      });

    let runningWhenFailed = -1;
    await app
      .get(ReconciliationService)
      .reconcile(new Date(FROM), new Date(TO))
      .catch(() => {
        runningWhenFailed = running;
      });

    expect(runningWhenFailed).toBe(0);
  });

  it("leaves connections for the rest of a run while a period check waits on the database", async () => {
    const holder = app.get(DataSource).createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(`LOCK TABLE "accounts", "ledger_entries", "settled_trades" IN ACCESS EXCLUSIVE MODE`);
    try {
      const check = app
        .get(ReconciliationService)
        .reconcile(new Date(FROM), new Date(TO))
        .catch(() => undefined);
      await eventually(async () => {
        const [{ waiting }] = await corrupt(
          `SELECT COUNT(*)::int AS "waiting" FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "datname" = current_database()`,
        );
        expect(waiting).toBe(6);
      });

      const started = Date.now();
      await app.get<DataSource>(RECONCILIATION_DATABASE).query("SELECT 1");
      expect(Date.now() - started).toBeLessThan(2_000);
      await holder.rollbackTransaction();
      await check;
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
    }
  });

  it("runs one period check at a time, so parallel runs do not starve each other of connections", async () => {
    const service = app.get(ReconciliationService) as unknown as {
      check: (from: Date, to: Date) => Promise<unknown>;
    };
    const original = service.check.bind(service);
    let running = 0;
    let most = 0;
    jest.spyOn(service, "check").mockImplementation(async (from: Date, to: Date) => {
      running += 1;
      most = Math.max(most, running);
      try {
        return await original(from, to);
      } finally {
        running -= 1;
      }
    });

    await Promise.all([
      reconcile().expect(200),
      reconcile().expect(200),
      reconcile({}).expect(200),
    ]);

    expect(most).toBe(1);
  });

  it("does not check past the oldest command a book has not applied yet", async () => {
    firstTradeAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    pendingSince = new Date(Date.now() - 2 * 3_600_000).toISOString();

    const first = await reconcile({}).expect(200);
    const asked = await reconcile({ from: firstTradeAt }).expect(200);

    expect(first.body.period).toEqual({ from: firstTradeAt, to: pendingSince });
    expect(asked.body.period.to).toBe(pendingSince);
    expect(asked.body.endedEarly).toMatch(/engine has not applied/);
  });

  it("checks only the ledger activity of the period it was asked about", async () => {
    await settle(app, trade({ executedAt: "2026-11-03T10:00:00.000Z" })).expect(
      200,
    );
    await corrupt(
      `UPDATE accounts SET balance = balance + 1 WHERE asset = 'ABC' AND kind = 'user'`,
    );

    const response = await reconcile().expect(200);

    expect(response.body.ledger.accountsOffEntries).toEqual([]);
  });

  it("is open only to admins and rejects a bad period", async () => {
    const asUser = (token: string) =>
      request(app.getHttpServer())
        .get("/admin/reconciliation")
        .set("authorization", `Bearer ${token}`);
    await request(app.getHttpServer()).get("/admin/reconciliation").expect(401);
    await request(app.getHttpServer())
      .get("/admin/reconciliation")
      .set("x-internal-key", process.env.SETTLEMENT_INTERNAL_KEY as string)
      .expect(401);
    await asUser(accessToken(randomUUID())).expect(403);
    await reconcile({ from: TO, to: FROM }).expect(400);
    await reconcile({ from: "yesterday" }).expect(400);
  });

  it("runs as a script that exits non-zero on a mismatch", async () => {
    await settleInPeriod();
    const run = async () => {
      const child = spawn(
        process.execPath,
        ["dist/reconciliation/reconcile.js", "--from", FROM, "--to", TO],
        {
          cwd: resolve(__dirname, "../.."),
          env: { ...process.env, ENGINE_URL: engineUrl },
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      const [code] = await once(child, "exit");
      return { code, report: JSON.parse(output) };
    };

    const clean = await run();
    await corrupt(
      `UPDATE accounts SET balance = balance - 1 WHERE "ownerId" = 'system' AND asset = 'ABC'`,
    );
    const broken = await run();

    expect([clean.code, clean.report.status]).toEqual([0, "ok"]);
    expect([broken.code, broken.report.status]).toEqual([1, "mismatch"]);
  });
});
