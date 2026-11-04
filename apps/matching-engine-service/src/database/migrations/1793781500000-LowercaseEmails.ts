import { MigrationInterface, QueryRunner } from 'typeorm';

export class LowercaseEmails1793781500000 implements MigrationInterface {
  name = 'LowercaseEmails1793781500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "users" AS "u" SET "email" = lower("u"."email")
        WHERE "u"."email" <> lower("u"."email")
          AND NOT EXISTS (
            SELECT 1 FROM "users" AS "other"
             WHERE lower("other"."email") = lower("u"."email") AND "other"."id" <> "u"."id"
          )`,
    );
  }

  public async down(): Promise<void> {}
}
