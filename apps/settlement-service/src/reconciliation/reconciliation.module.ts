import { Module } from '@nestjs/common';
import { EngineClient } from './engine-client';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

@Module({
  controllers: [ReconciliationController],
  providers: [ReconciliationService, EngineClient],
})
export class ReconciliationModule {}
