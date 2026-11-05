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

  async settleTrade(trade: SettleTradeDto): Promise<SettlementResult> {
    const result = await this.record(trade);
    if (result === 'settled') {
      await this.notifier.walletsChanged(trade.tradeId, [trade.buyerId, trade.sellerId]);
    }
    return result;
  }

  async settleAndAnnounce(trade: SettleTradeDto): Promise<SettlementResult> {
    const result = await this.record(trade);
    await this.notifier.announce(trade.tradeId, [trade.buyerId, trade.sellerId]);
    return result;
  }

  private record(trade: SettleTradeDto): Promise<SettlementResult> {
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
    const journal: JournalEntry[] = [];
    const ordered = accounts.sort(byKey((account) => `${account.ownerId}:${account.asset}`));
    for (const { ownerId, asset } of ordered) {
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(LedgerTransaction)
        .values({ reference: `opening:${ownerId}:${asset}`, kind: 'opening' })
        .orIgnore()
        .returning(['id'])
        .execute();
      const [opened] = result.raw as { id: string }[];
      if (opened) journal.push({ transactionId: opened.id, postings: openingPostings(ownerId, asset) });
    }
    return journal;
  }

  private async post(manager: EntityManager, journal: JournalEntry[]): Promise<void> {
    if (journal.some((entry) => !isBalanced(entry.postings))) {
      throw new Error('Refusing to post an unbalanced ledger transaction');
    }
    const deltas = new Map<string, Posting>();
    for (const posting of journal.flatMap((entry) => entry.postings)) {
      const key = `${posting.ownerId}:${posting.asset}`;
      const current = deltas.get(key);
      deltas.set(key, { ...posting, amount: (current?.amount ?? 0n) + posting.amount });
    }

    const accountIds = new Map<string, string>();
    for (const [key, delta] of [...deltas.entries()].sort(byKey(([key]) => key))) {
      const [account] = await manager.query(
        `INSERT INTO "accounts" ("ownerId", "asset", "kind", "balance")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("ownerId", "asset") DO UPDATE SET "balance" = "accounts"."balance" + EXCLUDED."balance"
         RETURNING "id"`,
        [
          delta.ownerId,
          delta.asset,
          delta.ownerId === SYSTEM_OWNER ? 'system' : 'user',
          fromUnits(delta.amount, LEDGER_SCALE),
        ],
      );
      accountIds.set(key, account.id);
    }

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
