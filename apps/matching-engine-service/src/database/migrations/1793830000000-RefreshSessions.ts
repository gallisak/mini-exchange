import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshSessions1793830000000 implements MigrationInterface {
  name = 'RefreshSessions1793830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "refresh_sessions" ("id" uuid NOT NULL, "userId" uuid NOT NULL, "familyId" uuid NOT NULL, "tokenHash" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "usedAt" TIMESTAMP WITH TIME ZONE, "revokedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_refresh_sessions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_refresh_sessions_user" ON "refresh_sessions" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_sessions_family" ON "refresh_sessions" ("familyId")`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "refreshTokenHash"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "refreshTokenHash" character varying`);
    await queryRunner.query(`DROP TABLE "refresh_sessions"`);
  }
}
