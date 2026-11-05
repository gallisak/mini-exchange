import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ledger_transactions')
export class LedgerTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_ledger_transactions_reference', { unique: true })
  @Column()
  reference: string;

  @Column()
  kind: string;

  @Index('IDX_ledger_transactions_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
