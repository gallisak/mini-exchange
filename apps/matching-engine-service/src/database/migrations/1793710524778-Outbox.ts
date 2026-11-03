import { MigrationInterface, QueryRunner } from 'typeorm';

export class Outbox1793710524778 implements MigrationInterface {
  name = 'Outbox1793710524778';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "outbox" ("id" BIGSERIAL NOT NULL, "stream" character varying NOT NULL, "type" character varying NOT NULL, "payload" jsonb NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "publishedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_unpublished" ON "outbox" ("id") WHERE "publishedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
  }
}
