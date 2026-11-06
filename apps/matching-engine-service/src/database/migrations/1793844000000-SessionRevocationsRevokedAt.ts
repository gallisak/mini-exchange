import { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionRevocationsRevokedAt1793844000000 implements MigrationInterface {
  name = 'SessionRevocationsRevokedAt1793844000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_session_revocations_revoked_at" ON "session_revocations" ("revokedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_session_revocations_revoked_at"`);
  }
}
