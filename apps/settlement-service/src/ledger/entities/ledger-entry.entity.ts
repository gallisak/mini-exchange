import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Account } from './account.entity';
import { LedgerTransaction } from './ledger-transaction.entity';

@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index('IDX_ledger_entries_transaction')
  @Column('uuid')
  transactionId: string;

  @ManyToOne(() => LedgerTransaction)
  @JoinColumn({ name: 'transactionId' })
  transaction?: LedgerTransaction;

  @Index('IDX_ledger_entries_account')
  @Column('uuid')
  accountId: string;

  @ManyToOne(() => Account)
  @JoinColumn({ name: 'accountId' })
  account?: Account;

  @Column()
  asset: string;

  @Column('numeric', { precision: 38, scale: 10 })
  amount: string;
}
