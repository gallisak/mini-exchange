import { MigrationInterface, QueryRunner } from 'typeorm';

export class CancelledRemaining1793790000000 implements MigrationInterface {
  name = 'CancelledRemaining1793790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "orders" SET "remainingQuantity" = "quantity" WHERE "status" = 'cancelled'`,
    );
    await queryRunner.query(
      `UPDATE "orders" AS "o" SET "remainingQuantity" = "o"."quantity" - "f"."filled"
         FROM (
           SELECT "orderId", SUM("quantity") AS "filled"
             FROM (
               SELECT "buyOrderId" AS "orderId", "quantity" FROM "trades"
               UNION ALL
               SELECT "sellOrderId" AS "orderId", "quantity" FROM "trades"
             ) AS "fills"
            GROUP BY "orderId"
         ) AS "f"
        WHERE "o"."id" = "f"."orderId" AND "o"."status" = 'cancelled'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "orders" SET "remainingQuantity" = 0 WHERE "status" = 'cancelled'`,
    );
  }
}
