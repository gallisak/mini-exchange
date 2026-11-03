import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommandLog1793697773929 implements MigrationInterface {
  name = 'CommandLog1793697773929';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "trades" ("id" uuid NOT NULL, "instrument" character varying NOT NULL, "seq" bigint NOT NULL, "buyOrderId" uuid NOT NULL, "sellOrderId" uuid NOT NULL, "buyerId" character varying NOT NULL, "sellerId" character varying NOT NULL, "price" numeric(18,2) NOT NULL, "quantity" numeric(18,8) NOT NULL, "executedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_c6d7c36a837411ba5194dc58595" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_trades_executed_at" ON "trades" ("executedAt")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_trades_instrument_seq" ON "trades" ("instrument", "seq")`,
    );
    await queryRunner.query(
      `CREATE TABLE "instrument_state" ("instrument" character varying NOT NULL, "lastCommandId" character varying NOT NULL DEFAULT '0-0', "orderSeq" bigint NOT NULL DEFAULT '0', "tradeSeq" bigint NOT NULL DEFAULT '0', "bookSeq" bigint NOT NULL DEFAULT '0', CONSTRAINT "PK_42267db28226116ce735d6f0a9b" PRIMARY KEY ("instrument"))`,
    );
    await queryRunner.query(`ALTER TABLE "orders" ADD "seq" bigint`);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_open_by_instrument" ON "orders" ("instrument", "seq") WHERE "status" IN ('open', 'partially_filled')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_owner_created" ON "orders" ("ownerId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_owner_created"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_open_by_instrument"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "seq"`);
    await queryRunner.query(`DROP TABLE "instrument_state"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_trades_instrument_seq"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_trades_executed_at"`);
    await queryRunner.query(`DROP TABLE "trades"`);
  }
}
