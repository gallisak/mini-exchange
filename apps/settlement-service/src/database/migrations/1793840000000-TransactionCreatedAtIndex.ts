import { MigrationInterface, QueryRunner } from 'typeorm';

export class TransactionCreatedAtIndex1793840000000 implements MigrationInterface {
  name = 'TransactionCreatedAtIndex1793840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_ledger_transactions_created_at" ON "ledger_transactions" ("createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_ledger_transactions_created_at"`);
  }
}
