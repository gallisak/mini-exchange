import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserRole1793781000000 implements MigrationInterface {
  name = 'UserRole1793781000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "role" character varying NOT NULL DEFAULT 'user'`);
    await queryRunner.query(`UPDATE "users" SET "refreshTokenHash" = NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
  }
}
