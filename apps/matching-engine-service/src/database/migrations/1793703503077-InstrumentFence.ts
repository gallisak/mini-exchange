import { MigrationInterface, QueryRunner } from 'typeorm';

export class InstrumentFence1793703503077 implements MigrationInterface {
  name = 'InstrumentFence1793703503077';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "instrument_state" ADD "fence" bigint NOT NULL DEFAULT '0'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "instrument_state" DROP COLUMN "fence"`);
  }
}
