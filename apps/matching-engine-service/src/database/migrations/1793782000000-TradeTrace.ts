import { MigrationInterface, QueryRunner } from 'typeorm';

export class TradeTrace1793782000000 implements MigrationInterface {
  name = 'TradeTrace1793782000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trades" ADD "traceId" character varying`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trades" DROP COLUMN "traceId"`);
  }
}
