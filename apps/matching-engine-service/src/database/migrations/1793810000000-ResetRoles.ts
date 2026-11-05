import { MigrationInterface, QueryRunner } from 'typeorm';

export class ResetRoles1793810000000 implements MigrationInterface {
  name = 'ResetRoles1793810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "users" SET "role" = 'user' WHERE "role" <> 'user'`);
  }

  public async down(): Promise<void> {}
}
