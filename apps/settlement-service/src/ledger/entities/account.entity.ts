import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('accounts')
@Index('IDX_accounts_owner_asset', ['ownerId', 'asset'], { unique: true })
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  ownerId: string;

  @Column()
  asset: string;

  @Column()
  kind: string;

  @Column('numeric', { precision: 38, scale: 10, default: 0 })
  balance: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
