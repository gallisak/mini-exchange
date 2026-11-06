import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  LEDGER_SCALE,
  PRICE_SCALE,
  QUANTITY_SCALE,
  fromUnits,
  toUnits,
} from "../common/decimal";
import { CASH_ASSET } from "../ledger/postings";
import {
  EngineClient,
  EngineInstrumentTotals,
  EngineProgress,
} from "./engine-client";
import { intEnv } from "../common/env";
import { ReconciliationCheckpoint } from "./reconciliation-checkpoint.entity";
import { SettlementBacklog } from "./settlement-backlog";
import { RECONCILIATION_DATABASE } from "./reconciliation-database";

const ISSUE_LIMIT = 100;
const CHECKPOINT = "default";
const RECHECK_LIMIT = 10;
const RECHECK_BUDGET_MS = 60_000;
const UNRESOLVED_LISTED = 100;
const SEVERITY: Record<ReconciliationStatus, number> = {
  ok: 0,
  incomplete: 1,
  mismatch: 2,
};

export type ReconciliationStatus = "ok" | "mismatch" | "incomplete";

export interface TradeTotals {
  count: number;
  quantity: string;
  notional: string;
}

export interface LedgerTradeTotals extends TradeTotals {
  cashMoved: string;
}

export interface InstrumentReconciliation {
  instrument: string;
  engine: TradeTotals | null;
  ledger: LedgerTradeTotals;
  matches: boolean;
}

export interface LedgerIssues {
  unbalancedTransactions: {
    transactionId: string;
    asset: string;
    total: string;
  }[];
  transactionsWithoutEntries: string[];
  accountsOffEntries: {
    accountId: string;
    ownerId: string;
    asset: string;
    balance: string;
    entries: string;
  }[];
  assetsNotBalanced: { asset: string; total: string }[];
  tradesOffEntries: string[];
}

export interface ReconciliationReport {
  status: ReconciliationStatus;
  period: { from: string; to: string };
  instruments: InstrumentReconciliation[];
  ledger: LedgerIssues;
  engineError?: string;
  endedEarly?: string;
  unresolved?: {
    from: string;
    to: string;
    status: ReconciliationStatus;
    rechecked: boolean;
  }[];
  unresolvedTotal?: number;
}

interface Progress {
  known: EngineProgress | null;
  waiting?: string;
  error?: string;
}

const units = (value: string | null | undefined) =>
  toUnits(value ?? "0", LEDGER_SCALE);
const quantity = (value: string | null | undefined) =>
  fromUnits(units(value), LEDGER_SCALE, QUANTITY_SCALE);
const money = (value: string | null | undefined) =>
  fromUnits(units(value), LEDGER_SCALE, PRICE_SCALE);

const EMPTY_LEDGER_TOTALS: LedgerTradeTotals = {
  count: 0,
  quantity: quantity("0"),
  notional: money("0"),
  cashMoved: money("0"),
};

@Injectable()
export class ReconciliationService implements OnModuleDestroy {
  private readonly lagMs = intEnv("RECONCILIATION_LAG_MS", 60_000, 0);
  private readonly stepMs = intEnv("RECONCILIATION_STEP_HOURS", 24) * 3_600_000;
  private running: Promise<ReconciliationReport> | null = null;

  constructor(
    @Inject(RECONCILIATION_DATABASE) private readonly dataSource: DataSource,
    private readonly engine: EngineClient,
    private readonly backlog: SettlementBacklog,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.running?.catch(() => undefined);
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }

  async reconcileUntil(from: Date, to?: Date): Promise<ReconciliationReport> {
    if (to && from.getTime() >= to.getTime()) {
      throw new BadRequestException("from must be earlier than to");
    }
    const latest = Date.now() - this.lagMs;
    const progress = await this.progress();
    const { end, endedEarly } = this.endOf(latest, to, progress);
    if (from.getTime() >= end) {
      return this.nothingNew(
        from,
        progress.error ?? endedEarly ?? "it is later than the last minute",
      );
    }
    const report = await this.reconcile(from, new Date(end));
    const checked = endedEarly ? { ...report, endedEarly } : report;
    return progress.error ? this.incomplete(checked, progress.error) : checked;
  }

  reconcileSinceCheckpoint(to?: Date): Promise<ReconciliationReport> {
    if (to) return this.runSinceCheckpoint(to);
    this.running ??= this.runSinceCheckpoint().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSinceCheckpoint(to?: Date): Promise<ReconciliationReport> {
    const latest = Date.now() - this.lagMs;
    const progress = await this.progress();
    const { end, endedEarly } = this.endOf(latest, to, progress);
    const checkpoint = await this.dataSource
      .getRepository(ReconciliationCheckpoint)
      .findOneBy({ name: CHECKPOINT });
    const reconciledUntil = checkpoint?.reconciledUntil.getTime() ?? null;
    const report =
      reconciledUntil !== null && reconciledUntil >= end
        ? this.nothingNew(
            new Date(reconciledUntil),
            progress.error ?? endedEarly ?? null,
          )
        : await this.reconcileNext(reconciledUntil, end, progress, endedEarly);
    const { unresolved, total } = await this.recheckUnresolved(report.period);
    const status = [
      report.status,
      ...unresolved.map((row) => row.status),
    ].reduce((worst, next) =>
      SEVERITY[next] > SEVERITY[worst] ? next : worst,
    );
    return { ...report, status, unresolved, unresolvedTotal: total };
  }

  private async reconcileNext(
    reconciledUntil: number | null,
    end: number,
    progress: Progress,
    endedEarly: string | undefined,
  ): Promise<ReconciliationReport> {
    let from =
      reconciledUntil ??
      (await this.firstActivity(progress.known?.firstTradeAt ?? null));
    if (from === null || from >= end) from = end - this.stepMs;
    const period = {
      from: new Date(from),
      to: new Date(Math.min(end, from + this.stepMs)),
    };
    const checked = await this.reconcile(period.from, period.to);
    const shortened =
      endedEarly && period.to.getTime() === end
        ? { ...checked, endedEarly }
        : checked;
    const report = progress.error
      ? this.incomplete(shortened, progress.error)
      : shortened;
    if (progress.error || report.status === "incomplete") return report;
    await this.dataSource.transaction(async (manager) => {
      if (report.status === "mismatch") {
        await manager.query(
          `INSERT INTO "reconciliation_unresolved_periods" ("from", "to", "checkedAt") VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
          [period.from, period.to],
        );
      }
      await manager.query(
        `INSERT INTO "reconciliation_checkpoints" ("name", "reconciledUntil") VALUES ($1, $2)
         ON CONFLICT ("name") DO UPDATE
           SET "reconciledUntil" = GREATEST("reconciliation_checkpoints"."reconciledUntil", EXCLUDED."reconciledUntil")`,
        [CHECKPOINT, period.to],
      );
    });
    return report;
  }

  private async progress(): Promise<Progress> {
    let engine: EngineProgress;
    try {
      engine = await this.engine.progress();
    } catch (error) {
      return {
        known: null,
        error: `Could not ask the engine which commands it has not applied: ${(error as Error).message}`,
      };
    }
    let oldest: Date | null;
    try {
      oldest = await this.backlog.oldestUnsettled();
    } catch (error) {
      return {
        known: engine,
        error: `Could not read which trades settlement has not settled yet: ${(error as Error).message}`,
      };
    }
    const engineFirst =
      engine.pendingSince !== null &&
      (oldest === null || engine.pendingSince.getTime() <= oldest.getTime());
    const pendingSince = engineFirst ? engine.pendingSince : oldest;
    return {
      known: { firstTradeAt: engine.firstTradeAt, pendingSince },
      waiting: !pendingSince
        ? undefined
        : engineFirst
          ? `the engine has not applied or published everything queued since ${pendingSince.toISOString()}`
          : `settlement has not settled a trade executed at ${pendingSince.toISOString()} yet`,
    };
  }

  private incomplete(
    report: ReconciliationReport,
    reason: string,
  ): ReconciliationReport {
    const ledgerBroken = Object.values(report.ledger).some(
      (issues) => issues.length > 0,
    );
    return {
      ...report,
      status: ledgerBroken ? "mismatch" : "incomplete",
      engineError: report.engineError ?? reason,
    };
  }

  private nothingNew(at: Date, reason: string | null): ReconciliationReport {
    const iso = at.toISOString();
    return {
      status: "incomplete",
      period: { from: iso, to: iso },
      instruments: [],
      ledger: {
        unbalancedTransactions: [],
        transactionsWithoutEntries: [],
        accountsOffEntries: [],
        assetsNotBalanced: [],
        tradesOffEntries: [],
      },
      engineError: reason
        ? `Nothing new to check from ${iso}: ${reason}`
        : `Nothing new to check after ${iso}`,
    };
  }

  private endOf(
    latest: number,
    to: Date | undefined,
    progress: Progress,
  ): { end: number; endedEarly?: string } {
    const asked = to?.getTime() ?? latest;
    const pending = progress.known?.pendingSince?.getTime() ?? Infinity;
    const end = Math.min(asked, latest, pending);
    if (end >= asked) return { end };
    return {
      end,
      endedEarly:
        end === pending && progress.waiting
          ? progress.waiting
          : `trades of the last ${Math.round(this.lagMs / 1000)} s may still be settling`,
    };
  }

  private async firstActivity(
    engineFirst: Date | null,
  ): Promise<number | null> {
    const ledger = await this.dataSource
      .query(
        `SELECT LEAST((SELECT MIN("executedAt") FROM "settled_trades"),
                      (SELECT MIN("createdAt") FROM "ledger_transactions")) AS "first"`,
      )
      .then(([row]: { first: Date | null }[]) =>
        row?.first ? new Date(row.first).getTime() : null,
      );
    const known = [ledger, engineFirst?.getTime() ?? null].filter(
      (time): time is number => time !== null,
    );
    return known.length > 0 ? Math.min(...known) : null;
  }

  private async recheckUnresolved(current: {
    from: string;
    to: string;
  }): Promise<{
    unresolved: NonNullable<ReconciliationReport["unresolved"]>;
    total: number;
  }> {
    const exceptCurrent = `NOT ("from" = $1::timestamptz AND "to" = $2::timestamptz)`;
    const keyOf = (period: { from: Date; to: Date }) =>
      `${new Date(period.from).toISOString()}/${new Date(period.to).toISOString()}`;
    const due: { from: Date; to: Date }[] = await this.dataSource.query(
      `SELECT "from", "to" FROM "reconciliation_unresolved_periods"
        WHERE ${exceptCurrent}
        ORDER BY "checkedAt" ASC NULLS FIRST, "from"
        LIMIT ${RECHECK_LIMIT}`,
      [current.from, current.to],
    );
    const started = Date.now();
    const rechecked = new Map<string, ReconciliationStatus>();
    for (const period of due) {
      if (Date.now() - started >= RECHECK_BUDGET_MS) break;
      const { status } = await this.reconcile(
        new Date(period.from),
        new Date(period.to),
      );
      if (status === "ok") {
        await this.dataSource.query(
          `DELETE FROM "reconciliation_unresolved_periods" WHERE "from" = $1 AND "to" = $2`,
          [period.from, period.to],
        );
        continue;
      }
      await this.dataSource.query(
        `UPDATE "reconciliation_unresolved_periods" SET "checkedAt" = now() WHERE "from" = $1 AND "to" = $2`,
        [period.from, period.to],
      );
      if (status === "mismatch") rechecked.set(keyOf(period), status);
    }
    const listed: { from: Date; to: Date }[] = await this.dataSource.query(
      `SELECT "from", "to" FROM "reconciliation_unresolved_periods"
        WHERE ${exceptCurrent}
        ORDER BY "from"
        LIMIT ${UNRESOLVED_LISTED}`,
      [current.from, current.to],
    );
    const shown = new Map<string, { from: Date; to: Date }>();
    for (const period of [
      ...due.filter((row) => rechecked.has(keyOf(row))),
      ...listed,
    ])
      shown.set(keyOf(period), period);
    const unresolved = [...shown.entries()]
      .slice(0, UNRESOLVED_LISTED)
      .map(([key, period]) => ({
        from: new Date(period.from).toISOString(),
        to: new Date(period.to).toISOString(),
        status: rechecked.get(key) ?? ("mismatch" as ReconciliationStatus),
        rechecked: rechecked.has(key),
      }))
      .sort((x, y) => x.from.localeCompare(y.from));
    const [{ total }]: { total: number }[] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "total" FROM "reconciliation_unresolved_periods" WHERE ${exceptCurrent}`,
      [current.from, current.to],
    );
    return { unresolved, total };
  }

  async reconcile(from: Date, to: Date): Promise<ReconciliationReport> {
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException("from must be earlier than to");
    }
    const [ledger, ledgerTotals, engine] = await Promise.all([
      this.ledgerIssues(from, to),
      this.ledgerTradeTotals(from, to),
      this.engine.tradeTotals(from, to).then(
        (totals) => ({ totals }),
        (error: Error) => ({ error: error.message }),
      ),
    ]);

    const engineTotals = "totals" in engine ? engine.totals : null;
    const instruments = [
      ...new Set([
        ...ledgerTotals.keys(),
        ...(engineTotals ?? []).map((row) => row.instrument),
      ]),
    ]
      .sort()
      .map((instrument) =>
        this.compare(instrument, ledgerTotals.get(instrument), engineTotals),
      );

    const ledgerBroken = Object.values(ledger).some(
      (issues) => issues.length > 0,
    );
    const status: ReconciliationStatus =
      ledgerBroken || instruments.some((row) => !row.matches)
        ? "mismatch"
        : engineTotals
          ? "ok"
          : "incomplete";

    return {
      status,
      period: { from: from.toISOString(), to: to.toISOString() },
      instruments,
      ledger,
      ...("error" in engine ? { engineError: engine.error } : {}),
    };
  }

  private compare(
    instrument: string,
    ledger: LedgerTradeTotals = EMPTY_LEDGER_TOTALS,
    engineTotals: EngineInstrumentTotals[] | null,
  ): InstrumentReconciliation {
    const reported = engineTotals?.find((row) => row.instrument === instrument);
    const engine: TradeTotals | null = engineTotals
      ? {
          count: reported?.count ?? 0,
          quantity: quantity(reported?.quantity),
          notional: money(reported?.notional),
        }
      : null;
    const matches =
      units(ledger.notional) === units(ledger.cashMoved) &&
      (engine === null ||
        (engine.count === ledger.count &&
          units(engine.quantity) === units(ledger.quantity) &&
          units(engine.notional) === units(ledger.cashMoved)));
    return { instrument, engine, ledger, matches };
  }

  private async ledgerTradeTotals(
    from: Date,
    to: Date,
  ): Promise<Map<string, LedgerTradeTotals>> {
    const rows: {
      instrument: string;
      count: number;
      quantity: string;
      notional: string;
      cashMoved: string;
    }[] = await this.dataSource.query(
      `SELECT st."instrument",
              COUNT(*)::int AS "count",
              SUM(st."quantity")::text AS "quantity",
              SUM(st."notional")::text AS "notional",
              SUM(moved."cash")::text AS "cashMoved"
         FROM "settled_trades" st
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(e."amount"), 0) AS "cash"
             FROM "ledger_entries" e
            WHERE e."transactionId" = st."transactionId" AND e."asset" = $3 AND e."amount" > 0
         ) moved ON true
        WHERE st."executedAt" >= $1 AND st."executedAt" < $2
        GROUP BY st."instrument"`,
      [from, to, CASH_ASSET],
    );
    return new Map(
      rows.map((row) => [
        row.instrument,
        {
          count: row.count,
          quantity: quantity(row.quantity),
          notional: money(row.notional),
          cashMoved: money(row.cashMoved),
        },
      ]),
    );
  }

  private async ledgerIssues(from: Date, to: Date): Promise<LedgerIssues> {
    const inPeriod = `
      SELECT st."transactionId" AS "id" FROM "settled_trades" st
       WHERE st."executedAt" >= $1 AND st."executedAt" < $2
      UNION
      SELECT t."id" FROM "ledger_transactions" t
       WHERE t."createdAt" >= $1 AND t."createdAt" < $2`;
    const [unbalanced, withoutEntries, accounts, assets, trades] =
      await Promise.all([
        this.dataSource.query(
          `SELECT e."transactionId", e."asset", SUM(e."amount")::text AS "total"
           FROM "ledger_entries" e
          WHERE e."transactionId" IN (${inPeriod})
          GROUP BY e."transactionId", e."asset"
         HAVING SUM(e."amount") <> 0
          ORDER BY e."transactionId", e."asset"
          LIMIT ${ISSUE_LIMIT}`,
          [from, to],
        ),
        this.dataSource.query(
          `SELECT t."id"
           FROM "ledger_transactions" t
          WHERE t."id" IN (${inPeriod})
            AND NOT EXISTS (SELECT 1 FROM "ledger_entries" e WHERE e."transactionId" = t."id")
          ORDER BY t."id"
          LIMIT ${ISSUE_LIMIT}`,
          [from, to],
        ),
        this.dataSource.query(
          `WITH "touched" AS (
           SELECT e."accountId" AS "id" FROM "ledger_entries" e WHERE e."transactionId" IN (${inPeriod})
           UNION
           SELECT a."id" FROM "accounts" a
             JOIN "settled_trades" st ON a."ownerId" IN (st."buyerId", st."sellerId")
            WHERE st."executedAt" >= $1 AND st."executedAt" < $2
         )
         SELECT a."id" AS "accountId", a."ownerId", a."asset", a."balance"::text AS "balance",
                COALESCE(SUM(e."amount"), 0)::text AS "entries"
           FROM "accounts" a
           LEFT JOIN "ledger_entries" e ON e."accountId" = a."id"
          WHERE a."id" IN (SELECT "id" FROM "touched")
          GROUP BY a."id"
         HAVING a."balance" <> COALESCE(SUM(e."amount"), 0)
          ORDER BY a."id"
          LIMIT ${ISSUE_LIMIT}`,
          [from, to],
        ),
        this.dataSource.query(
          `SELECT "asset", SUM("balance")::text AS "total"
           FROM "accounts"
          GROUP BY "asset"
         HAVING SUM("balance") <> 0
          ORDER BY "asset"`,
        ),
        this.dataSource.query(
          `SELECT st."tradeId"
           FROM "settled_trades" st
           LEFT JOIN "ledger_entries" e ON e."transactionId" = st."transactionId"
           LEFT JOIN "accounts" a ON a."id" = e."accountId"
          WHERE st."executedAt" >= $1 AND st."executedAt" < $2
          GROUP BY st."tradeId"
         HAVING st."price" * st."quantity" <> st."notional"
             OR COUNT(e."id") <> 4
             OR COUNT(e."id") FILTER (WHERE a."asset" IS DISTINCT FROM e."asset") > 0
             OR COUNT(e."id") FILTER (
                  WHERE a."ownerId" = st."buyerId" AND e."asset" = $3 AND e."amount" = -st."notional") <> 1
             OR COUNT(e."id") FILTER (
                  WHERE a."ownerId" = st."sellerId" AND e."asset" = $3 AND e."amount" = st."notional") <> 1
             OR COUNT(e."id") FILTER (
                  WHERE a."ownerId" = st."buyerId" AND e."asset" = st."instrument" AND e."amount" = st."quantity") <> 1
             OR COUNT(e."id") FILTER (
                  WHERE a."ownerId" = st."sellerId" AND e."asset" = st."instrument" AND e."amount" = -st."quantity") <> 1
          ORDER BY st."tradeId"
          LIMIT ${ISSUE_LIMIT}`,
          [from, to, CASH_ASSET],
        ),
      ]);
    return {
      unbalancedTransactions: unbalanced.map(
        (row: { transactionId: string; asset: string; total: string }) => ({
          ...row,
          total: money(row.total),
        }),
      ),
      transactionsWithoutEntries: withoutEntries.map(
        (row: { id: string }) => row.id,
      ),
      accountsOffEntries: accounts.map(
        (row: LedgerIssues["accountsOffEntries"][number]) => ({
          ...row,
          balance: money(row.balance),
          entries: money(row.entries),
        }),
      ),
      assetsNotBalanced: assets.map(
        (row: { asset: string; total: string }) => ({
          asset: row.asset,
          total: money(row.total),
        }),
      ),
      tradesOffEntries: trades.map((row: { tradeId: string }) => row.tradeId),
    };
  }
}
