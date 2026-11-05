import { MigrationInterface, QueryRunner } from 'typeorm';

export class OutboxPublishedIndex1793840000000 implements MigrationInterface {
  name = 'OutboxPublishedIndex1793840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_published_at" ON "outbox" ("publishedAt") WHERE "publishedAt" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_outbox_published_at"`);
  }
}
