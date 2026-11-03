import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('instrument_state')
export class InstrumentState {
  @PrimaryColumn()
  instrument: string;

  @Column({ type: 'varchar', default: '0-0' })
  lastCommandId: string;

  @Column('bigint', { default: 0 })
  orderSeq: string;

  @Column('bigint', { default: 0 })
  tradeSeq: string;

  @Column('bigint', { default: 0 })
  bookSeq: string;

  @Column('bigint', { default: 0 })
  fence: string;
}
