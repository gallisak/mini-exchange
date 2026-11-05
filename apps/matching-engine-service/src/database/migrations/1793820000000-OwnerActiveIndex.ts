import { MigrationInterface, QueryRunner } from 'typeorm';

export class OwnerActiveIndex1793820000000 implements MigrationInterface {
  name = 'OwnerActiveIndex1793820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_orders_owner_status"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_owner_active" ON "orders" ("ownerId", "createdAt") WHERE "status" IN ('open', 'partially_filled')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_owner_active"`);
    await queryRunner.query(`CREATE INDEX "IDX_orders_owner_status" ON "orders" ("ownerId", "status")`);
  }
}
