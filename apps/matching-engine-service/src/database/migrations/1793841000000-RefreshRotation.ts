import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshRotation1793841000000 implements MigrationInterface {
  name = 'RefreshRotation1793841000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refresh_sessions" ADD "rotationAttempt" character varying`);
    await queryRunner.query(`ALTER TABLE "refresh_sessions" ADD "successorId" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "refresh_sessions" DROP COLUMN "successorId"`);
    await queryRunner.query(`ALTER TABLE "refresh_sessions" DROP COLUMN "rotationAttempt"`);
  }
}
