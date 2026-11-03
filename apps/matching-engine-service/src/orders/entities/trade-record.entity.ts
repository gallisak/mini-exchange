import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('trades')
@Index('IDX_trades_instrument_seq', ['instrument', 'seq'], { unique: true })
@Index('IDX_trades_executed_at', ['executedAt'])
export class TradeRecord {
  @PrimaryColumn('uuid')
  id: string;

  @Column()
  instrument: string;

  @Column('bigint')
  seq: string;

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

  @Column({ type: 'timestamptz' })
  executedAt: Date;
}
