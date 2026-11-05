import { MigrationInterface, QueryRunner } from 'typeorm';

export class OwnerStatusIndex1793800000000 implements MigrationInterface {
  name = 'OwnerStatusIndex1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_owner_status" ON "orders" ("ownerId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_owner_status"`);
  }
}
