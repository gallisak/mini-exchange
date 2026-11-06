import { MigrationInterface, QueryRunner } from 'typeorm';

export class UnresolvedPeriods1793860000000 implements MigrationInterface {
  name = 'UnresolvedPeriods1793860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "reconciliation_unresolved_periods" ("from" TIMESTAMP WITH TIME ZONE NOT NULL, "to" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_reconciliation_unresolved_periods" PRIMARY KEY ("from", "to"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reconciliation_unresolved_periods"`);
  }
}
