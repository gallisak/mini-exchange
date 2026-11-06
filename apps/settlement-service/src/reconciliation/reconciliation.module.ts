import { Module } from "@nestjs/common";
import { EngineClient } from "./engine-client";
import { ReconciliationController } from "./reconciliation.controller";
import { ReconciliationService } from "./reconciliation.service";
import { SettlementBacklog } from "./settlement-backlog";

@Module({
  controllers: [ReconciliationController],
  providers: [ReconciliationService, EngineClient, SettlementBacklog],
})
export class ReconciliationModule {}
