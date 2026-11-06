import { MigrationInterface, QueryRunner } from 'typeorm';

export class UnresolvedPeriodCheckedAt1793870000000 implements MigrationInterface {
  name = 'UnresolvedPeriodCheckedAt1793870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reconciliation_unresolved_periods" ADD "checkedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "reconciliation_unresolved_periods" DROP COLUMN "checkedAt"`);
  }
}
