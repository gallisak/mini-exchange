import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshSessionsCreatedIndex1793845000000 implements MigrationInterface {
  name = 'RefreshSessionsCreatedIndex1793845000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [existing]: { valid: boolean }[] = await queryRunner.query(
      `SELECT i."indisvalid" AS "valid" FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'IDX_refresh_sessions_created' AND n.nspname = current_schema()`,
    );
    if (existing?.valid) return;
    if (existing) await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_refresh_sessions_created"`);
    await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_refresh_sessions_created" ON "refresh_sessions" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "IDX_refresh_sessions_created"`);
  }
}
