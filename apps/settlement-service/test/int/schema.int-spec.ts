import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { Account } from '../../src/ledger/entities/account.entity';
import { LedgerTransaction } from '../../src/ledger/entities/ledger-transaction.entity';
import { resetState } from './harness';

describe('ledger schema', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    await resetState();
    dataSource = await new DataSource(buildDataSourceOptions()).initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('keeps one account per owner and asset', async () => {
    const accounts = dataSource.getRepository(Account);
    await accounts.insert({ ownerId: 'owner', asset: 'USD', kind: 'user' });

    await expect(accounts.insert({ ownerId: 'owner', asset: 'USD', kind: 'user' })).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('keeps one ledger transaction per reference', async () => {
    const transactions = dataSource.getRepository(LedgerTransaction);
    await transactions.insert({ reference: 'trade:1', kind: 'trade' });

    await expect(transactions.insert({ reference: 'trade:1', kind: 'trade' })).rejects.toThrow(
      /duplicate key/,
    );
  });
});
