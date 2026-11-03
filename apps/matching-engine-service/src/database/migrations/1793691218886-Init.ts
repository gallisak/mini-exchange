import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1793691218886 implements MigrationInterface {
  name = 'Init1793691218886';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "refreshTokenHash" character varying, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ownerId" character varying NOT NULL, "instrument" character varying NOT NULL, "side" character varying NOT NULL, "price" numeric(18,2) NOT NULL, "quantity" numeric(18,8) NOT NULL, "remainingQuantity" numeric(18,8) NOT NULL, "status" character varying NOT NULL DEFAULT 'open', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
