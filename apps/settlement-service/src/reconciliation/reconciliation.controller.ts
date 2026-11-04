import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ReconciliationKeyGuard } from '../auth/internal-key.guard';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import { ReconciliationService } from './reconciliation.service';

@Controller('admin/reconciliation')
@UseGuards(ReconciliationKeyGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  reconcile(@Query() query: ReconciliationQueryDto) {
    const period = this.reconciliation.defaultPeriod();
    return this.reconciliation.reconcile(
      query.from ? new Date(query.from) : period.from,
      query.to ? new Date(query.to) : period.to,
    );
  }
}
