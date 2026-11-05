import { MigrationInterface, QueryRunner } from 'typeorm';

export class EmailLowerIndex1793842000000 implements MigrationInterface {
  name = 'EmailLowerIndex1793842000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_users_email_lower" ON "users" (lower("email"))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_users_email_lower"`);
  }
}
