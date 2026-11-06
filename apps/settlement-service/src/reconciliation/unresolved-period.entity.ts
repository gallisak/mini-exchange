import { Entity, PrimaryColumn } from 'typeorm';

@Entity('reconciliation_unresolved_periods')
export class UnresolvedPeriod {
  @PrimaryColumn({ type: 'timestamptz' })
  from: Date;

  @PrimaryColumn({ type: 'timestamptz' })
  to: Date;
}
