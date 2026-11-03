import { MigrationInterface, QueryRunner } from 'typeorm';

export class Ledger1793710674393 implements MigrationInterface {
  name = 'Ledger1793710674393';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "accounts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ownerId" character varying NOT NULL, "asset" character varying NOT NULL, "kind" character varying NOT NULL, "balance" numeric(38,10) NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5a7a02c20412299d198e097a8fe" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_accounts_owner_asset" ON "accounts" ("ownerId", "asset") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ledger_transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "reference" character varying NOT NULL, "kind" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_633d103c9e415d615aacf9b1929" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ledger_transactions_reference" ON "ledger_transactions" ("reference") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ledger_entries" ("id" BIGSERIAL NOT NULL, "transactionId" uuid NOT NULL, "accountId" uuid NOT NULL, "asset" character varying NOT NULL, "amount" numeric(38,10) NOT NULL, CONSTRAINT "PK_6efcb84411d3f08b08450ae75d5" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ledger_entries_transaction" ON "ledger_entries" ("transactionId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ledger_entries_account" ON "ledger_entries" ("accountId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "settled_trades" ("tradeId" uuid NOT NULL, "instrument" character varying NOT NULL, "buyOrderId" uuid NOT NULL, "sellOrderId" uuid NOT NULL, "buyerId" character varying NOT NULL, "sellerId" character varying NOT NULL, "price" numeric(18,2) NOT NULL, "quantity" numeric(18,8) NOT NULL, "notional" numeric(38,10) NOT NULL, "executedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "transactionId" uuid NOT NULL, "settledAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cd4d9e7ad4669cf6b67d77999b9" PRIMARY KEY ("tradeId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_settled_trades_instrument_executed_at" ON "settled_trades" ("instrument", "executedAt") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_settled_trades_executed_at" ON "settled_trades" ("executedAt") `,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ADD CONSTRAINT "FK_ce01dd5f8bde23f503bf01ffacc" FOREIGN KEY ("transactionId") REFERENCES "ledger_transactions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" ADD CONSTRAINT "FK_c5434f6dfb7b6f304a450d93046" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" DROP CONSTRAINT "FK_c5434f6dfb7b6f304a450d93046"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ledger_entries" DROP CONSTRAINT "FK_ce01dd5f8bde23f503bf01ffacc"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_settled_trades_executed_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_settled_trades_instrument_executed_at"`);
    await queryRunner.query(`DROP TABLE "settled_trades"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ledger_entries_account"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ledger_entries_transaction"`);
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_ledger_transactions_reference"`);
    await queryRunner.query(`DROP TABLE "ledger_transactions"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_accounts_owner_asset"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
  }
}
