import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReconciliationCheckpoint1793850000000 implements MigrationInterface {
  name = 'ReconciliationCheckpoint1793850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "reconciliation_checkpoints" ("name" character varying NOT NULL, "reconciledUntil" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_reconciliation_checkpoints" PRIMARY KEY ("name"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "reconciliation_checkpoints"`);
  }
}
