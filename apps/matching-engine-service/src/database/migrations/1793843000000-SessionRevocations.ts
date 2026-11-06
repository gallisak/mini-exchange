import { MigrationInterface, QueryRunner } from 'typeorm';

export class SessionRevocations1793843000000 implements MigrationInterface {
  name = 'SessionRevocations1793843000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "session_revocations" ("familyId" uuid NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "announcedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_session_revocations" PRIMARY KEY ("familyId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_session_revocations_unannounced" ON "session_revocations" ("revokedAt") WHERE "announcedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_session_revocations_unannounced"`);
    await queryRunner.query(`DROP TABLE "session_revocations"`);
  }
}
