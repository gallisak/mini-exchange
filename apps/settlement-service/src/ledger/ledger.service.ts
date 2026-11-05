import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { LEDGER_SCALE, fromUnits, toUnits } from '../common/decimal';
import { SettleTradeDto } from '../trades/dto/settle-trade.dto';
import { Account } from './entities/account.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerTransaction } from './entities/ledger-transaction.entity';
import { SettledTrade } from './entities/settled-trade.entity';
import {
  CASH_ASSET,
  Posting,
  SYSTEM_OWNER,
  WALLET_ASSETS,
  displayScale,
  isBalanced,
  notional,
  openingPostings,
  tradePostings,
} from './postings';
import { TradeConflictError } from './trade-conflict.error';
import { WalletNotifier } from '../notifications/wallet-notifier.service';

export type SettlementResult = 'settled' | 'duplicate';

export interface WalletBalance {
  asset: string;
  balance: string;
}

interface JournalEntry {
  transactionId: string;
  postings: Posting[];
}

const byKey = <T>(key: (item: T) => string) => (a: T, b: T) =>
  key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

@Injectable()
export class LedgerService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notifier: WalletNotifier,
  ) {}

  announce(trade: SettleTradeDto): Promise<void> {
    return this.notifier.announce(trade.tradeId, [trade.buyerId, trade.sellerId]);
  }

  settle(trade: SettleTradeDto): Promise<SettlementResult> {
    return this.dataSource.transaction(async (manager) => {
      const [transaction] = await manager
        .createQueryBuilder()
        .insert()
        .into(LedgerTransaction)
        .values({ reference: `trade:${trade.tradeId}`, kind: 'trade' })
        .orIgnore()
        .returning(['id'])
        .execute()
        .then((result) => result.raw as { id: string }[]);

      if (!transaction) {
        const existing = await manager.findOneByOrFail(SettledTrade, { tradeId: trade.tradeId });
        if (!sameTrade(existing, trade)) throw new TradeConflictError(trade.tradeId);
        return 'duplicate';
      }

      await manager.insert(SettledTrade, {
        tradeId: trade.tradeId,
        instrument: trade.instrument,
        buyOrderId: trade.buyOrderId,
        sellOrderId: trade.sellOrderId,
        buyerId: trade.buyerId,
        sellerId: trade.sellerId,
        price: trade.price,
        quantity: trade.quantity,
        notional: fromUnits(notional(trade.price, trade.quantity), LEDGER_SCALE),
        executedAt: new Date(trade.executedAt),
        transactionId: transaction.id,
      });

      const openings = await this.openAccounts(
        manager,
        [trade.buyerId, trade.sellerId].flatMap((ownerId) =>
          [CASH_ASSET, trade.instrument].map((asset) => ({ ownerId, asset })),
        ),
      );
      await this.post(manager, [
        ...openings,
        { transactionId: transaction.id, postings: tradePostings(trade) },
      ]);
      return 'settled';
    });
  }

  async wallet(ownerId: string): Promise<WalletBalance[]> {
    let accounts = await this.accountsOf(ownerId);
    if (accounts.length < WALLET_ASSETS.length) {
      await this.dataSource.transaction(async (manager) => {
        const journal = await this.openAccounts(
          manager,
          WALLET_ASSETS.map((asset) => ({ ownerId, asset })),
        );
        await this.post(manager, journal);
      });
      accounts = await this.accountsOf(ownerId);
    }
    const balances = new Map(accounts.map((account) => [account.asset, account.balance]));
    return WALLET_ASSETS.filter((asset) => balances.has(asset)).map((asset) => ({
      asset,
      balance: fromUnits(
        toUnits(balances.get(asset) as string, LEDGER_SCALE),
        LEDGER_SCALE,
        displayScale(asset),
      ),
    }));
  }

  private accountsOf(ownerId: string): Promise<Account[]> {
    return this.dataSource.getRepository(Account).findBy({ ownerId });
  }

  private async openAccounts(
    manager: EntityManager,
    accounts: { ownerId: string; asset: string }[],
  ): Promise<JournalEntry[]> {
    const ordered = accounts.sort(byKey((account) => `${account.ownerId}:${account.asset}`));
    const references = new Map(
      ordered.map((account) => [`opening:${account.ownerId}:${account.asset}`, account]),
    );
    if (references.size === 0) return [];
    const opened: { id: string; reference: string }[] = await manager.query(
      `INSERT INTO "ledger_transactions" ("reference", "kind")
       SELECT "reference", 'opening' FROM unnest($1::varchar[]) WITH ORDINALITY AS r("reference", "position")
        ORDER BY "position"
       ON CONFLICT ("reference") DO NOTHING
       RETURNING "id", "reference"`,
      [[...references.keys()]],
    );
    return opened
      .sort(byKey((row) => row.reference))
      .map((row) => {
        const { ownerId, asset } = references.get(row.reference) as { ownerId: string; asset: string };
        return { transactionId: row.id, postings: openingPostings(ownerId, asset) };
      });
  }

  private async post(manager: EntityManager, journal: JournalEntry[]): Promise<void> {
    if (journal.length === 0) return;
    if (journal.some((entry) => !isBalanced(entry.postings))) {
      throw new Error('Refusing to post an unbalanced ledger transaction');
    }
    const deltas = new Map<string, Posting>();
    for (const posting of journal.flatMap((entry) => entry.postings)) {
      const key = `${posting.ownerId}:${posting.asset}`;
      const current = deltas.get(key);
      deltas.set(key, { ...posting, amount: (current?.amount ?? 0n) + posting.amount });
    }

    const ordered = [...deltas.values()].sort(byKey((delta) => `${delta.ownerId}:${delta.asset}`));
    const accounts: { id: string; ownerId: string; asset: string }[] = await manager.query(
      `INSERT INTO "accounts" ("ownerId", "asset", "kind", "balance")
       SELECT "ownerId", "asset", "kind", "balance"
         FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::numeric[])
              WITH ORDINALITY AS d("ownerId", "asset", "kind", "balance", "position")
        ORDER BY "position"
       ON CONFLICT ("ownerId", "asset") DO UPDATE SET "balance" = "accounts"."balance" + EXCLUDED."balance"
       RETURNING "id", "ownerId", "asset"`,
      [
        ordered.map((delta) => delta.ownerId),
        ordered.map((delta) => delta.asset),
        ordered.map((delta) => (delta.ownerId === SYSTEM_OWNER ? 'system' : 'user')),
        ordered.map((delta) => fromUnits(delta.amount, LEDGER_SCALE)),
      ],
    );
    const accountIds = new Map(accounts.map((account) => [`${account.ownerId}:${account.asset}`, account.id]));

    await manager.insert(
      LedgerEntry,
      journal.flatMap((entry) =>
        entry.postings.map((posting) => ({
          transactionId: entry.transactionId,
          accountId: accountIds.get(`${posting.ownerId}:${posting.asset}`) as string,
          asset: posting.asset,
          amount: fromUnits(posting.amount, LEDGER_SCALE),
        })),
      ),
    );
  }
}

export function sameTrade(existing: SettledTrade, trade: SettleTradeDto): boolean {
  return (
    existing.instrument === trade.instrument &&
    existing.buyOrderId === trade.buyOrderId &&
    existing.sellOrderId === trade.sellOrderId &&
    existing.buyerId === trade.buyerId &&
    existing.sellerId === trade.sellerId &&
    toUnits(existing.price, LEDGER_SCALE) === toUnits(trade.price, LEDGER_SCALE) &&
    toUnits(existing.quantity, LEDGER_SCALE) === toUnits(trade.quantity, LEDGER_SCALE) &&
    existing.executedAt.getTime() === new Date(trade.executedAt).getTime()
  );
}
