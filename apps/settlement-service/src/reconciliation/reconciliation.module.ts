import { Module } from "@nestjs/common";
import { EngineClient } from "./engine-client";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { SettlementBacklog } from "./settlement-backlog";
import { reconciliationDatabase } from "./reconciliation-database";

@Module({
  controllers: [ReconciliationController],
  providers: [ReconciliationService, EngineClient, SettlementBacklog, reconciliationDatabase],
})
export class ReconciliationModule {}
