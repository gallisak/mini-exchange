import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LEDGER_SCALE, PRICE_SCALE, QUANTITY_SCALE, fromUnits, toUnits } from '../common/decimal';
import { CASH_ASSET } from '../ledger/postings';
import { EngineClient, EngineInstrumentTotals } from './engine-client';
import { intEnv } from '../common/env';
import { ReconciliationCheckpoint } from './reconciliation-checkpoint.entity';

const ISSUE_LIMIT = 100;
const CHECKPOINT = 'default';

export type ReconciliationStatus = 'ok' | 'mismatch' | 'incomplete';

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
  unbalancedTransactions: { transactionId: string; asset: string; total: string }[];
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
}

const units = (value: string | null | undefined) => toUnits(value ?? '0', LEDGER_SCALE);
const quantity = (value: string | null | undefined) =>
  fromUnits(units(value), LEDGER_SCALE, QUANTITY_SCALE);
const money = (value: string | null | undefined) => fromUnits(units(value), LEDGER_SCALE, PRICE_SCALE);

const EMPTY_LEDGER_TOTALS: LedgerTradeTotals = {
  count: 0,
  quantity: quantity('0'),
  notional: money('0'),
  cashMoved: money('0'),
};

@Injectable()
export class ReconciliationService {
  private readonly lagMs = intEnv('RECONCILIATION_LAG_MS', 60_000, 0);
  private readonly stepMs = intEnv('RECONCILIATION_STEP_HOURS', 24) * 3_600_000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: EngineClient,
  ) {}

  periodEnd(to?: Date): Date {
    const latest = Date.now() - this.lagMs;
    return new Date(Math.min(to?.getTime() ?? latest, latest));
  }

  async defaultPeriod(to?: Date): Promise<{ from: Date; to: Date }> {
    const end = this.periodEnd(to).getTime();
    const checkpoint = await this.dataSource
      .getRepository(ReconciliationCheckpoint)
      .findOneBy({ name: CHECKPOINT });
    let from =
      checkpoint && checkpoint.reconciledUntil.getTime() < end
        ? checkpoint.reconciledUntil.getTime()
        : await this.firstActivity();
    if (from === null || from >= end) from = end - this.stepMs;
    return { from: new Date(from), to: new Date(Math.min(end, from + this.stepMs)) };
  }

  private async firstActivity(): Promise<number | null> {
    const [ledger, engine] = await Promise.all([
      this.dataSource
        .query(
          `SELECT LEAST((SELECT MIN("executedAt") FROM "settled_trades"),
                        (SELECT MIN("createdAt") FROM "ledger_transactions")) AS "first"`,
        )
        .then(([row]: { first: Date | null }[]) => (row?.first ? new Date(row.first).getTime() : null)),
      this.engine.firstTradeAt().then(
        (first) => first?.getTime() ?? null,
        () => null,
      ),
    ]);
    const known = [ledger, engine].filter((time): time is number => time !== null);
    return known.length > 0 ? Math.min(...known) : null;
  }

  async reconcileSinceCheckpoint(to?: Date): Promise<ReconciliationReport> {
    const period = await this.defaultPeriod(to);
    const report = await this.reconcile(period.from, period.to);
    if (report.status === 'ok') {
      await this.dataSource.query(
        `INSERT INTO "reconciliation_checkpoints" ("name", "reconciledUntil") VALUES ($1, $2)
         ON CONFLICT ("name") DO UPDATE
           SET "reconciledUntil" = GREATEST("reconciliation_checkpoints"."reconciledUntil", EXCLUDED."reconciledUntil")`,
        [CHECKPOINT, period.to],
      );
    }
    return report;
  }

  async reconcile(from: Date, to: Date): Promise<ReconciliationReport> {
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from must be earlier than to');
    }
    const [ledger, ledgerTotals, engine] = await Promise.all([
      this.ledgerIssues(from, to),
      this.ledgerTradeTotals(from, to),
      this.engine.tradeTotals(from, to).then(
        (totals) => ({ totals }),
        (error: Error) => ({ error: error.message }),
      ),
    ]);

    const engineTotals = 'totals' in engine ? engine.totals : null;
    const instruments = [
      ...new Set([...ledgerTotals.keys(), ...(engineTotals ?? []).map((row) => row.instrument)]),
    ]
      .sort()
      .map((instrument) => this.compare(instrument, ledgerTotals.get(instrument), engineTotals));

    const ledgerBroken = Object.values(ledger).some((issues) => issues.length > 0);
    const status: ReconciliationStatus =
      ledgerBroken || instruments.some((row) => !row.matches)
        ? 'mismatch'
        : engineTotals
          ? 'ok'
          : 'incomplete';

    return {
      status,
      period: { from: from.toISOString(), to: to.toISOString() },
      instruments,
      ledger,
      ...('error' in engine ? { engineError: engine.error } : {}),
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

  private async ledgerTradeTotals(from: Date, to: Date): Promise<Map<string, LedgerTradeTotals>> {
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
    const [unbalanced, withoutEntries, accounts, assets, trades] = await Promise.all([
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
      transactionsWithoutEntries: withoutEntries.map((row: { id: string }) => row.id),
      accountsOffEntries: accounts.map(
        (row: LedgerIssues['accountsOffEntries'][number]) => ({
          ...row,
          balance: money(row.balance),
          entries: money(row.entries),
        }),
      ),
      assetsNotBalanced: assets.map((row: { asset: string; total: string }) => ({
        asset: row.asset,
        total: money(row.total),
      })),
      tradesOffEntries: trades.map((row: { tradeId: string }) => row.tradeId),
    };
  }
}
