import { MigrationInterface, QueryRunner } from 'typeorm';
import { RefreshSessionsCreatedIndex1793845000000 } from './1793845000000-RefreshSessionsCreatedIndex';

export class RepairRefreshSessionsCreatedIndex1793846000000 implements MigrationInterface {
  name = 'RepairRefreshSessionsCreatedIndex1793846000000';
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await new RefreshSessionsCreatedIndex1793845000000().up(queryRunner);
  }

  public async down(): Promise<void> {
    return;
  }
}
