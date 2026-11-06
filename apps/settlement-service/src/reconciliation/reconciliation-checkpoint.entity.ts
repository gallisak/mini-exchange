import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity("reconciliation_checkpoints")
export class ReconciliationCheckpoint {
  @PrimaryColumn()
  name: string;

  @Column({ type: "timestamptz" })
  reconciledUntil: Date;
}
