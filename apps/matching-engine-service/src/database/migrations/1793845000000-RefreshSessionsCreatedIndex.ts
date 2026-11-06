import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshSessionsCreatedIndex1793845000000 implements MigrationInterface {
  name = 'RefreshSessionsCreatedIndex1793845000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_refresh_sessions_created" ON "refresh_sessions" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_refresh_sessions_created"`);
  }
}
