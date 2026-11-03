import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('settled_trades')
@Index('IDX_settled_trades_executed_at', ['executedAt'])
@Index('IDX_settled_trades_instrument_executed_at', ['instrument', 'executedAt'])
export class SettledTrade {
  @PrimaryColumn('uuid')
  tradeId: string;

  @Column()
  instrument: string;

  @Column('uuid')
  buyOrderId: string;

  @Column('uuid')
  sellOrderId: string;

  @Column()
  buyerId: string;

  @Column()
  sellerId: string;

  @Column('numeric', { precision: 18, scale: 2 })
  price: string;

  @Column('numeric', { precision: 18, scale: 8 })
  quantity: string;

  @Column('numeric', { precision: 38, scale: 10 })
  notional: string;

  @Column({ type: 'timestamptz' })
  executedAt: Date;

  @Column('uuid')
  transactionId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  settledAt: Date;
}
