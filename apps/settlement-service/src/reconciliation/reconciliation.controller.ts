import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/reconciliation')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get()
  async reconcile(@Query() query: ReconciliationQueryDto) {
    const to = query.to ? new Date(query.to) : undefined;
    if (!query.from) return this.reconciliation.reconcileSinceCheckpoint(to);
    return this.reconciliation.reconcileUntil(new Date(query.from), to);
  }
}
