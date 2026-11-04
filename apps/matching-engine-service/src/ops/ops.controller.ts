import { Controller, Get, Header, HttpStatus, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { metricsRegistry } from '../observability/metrics';
import { OpsService } from './ops.service';

@Controller()
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('health')
  async health(@Res({ passthrough: true }) response: Response) {
    const health = await this.ops.health();
    if (health.status !== 'ok') response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }

  @Get('metrics')
  @Header('content-type', metricsRegistry.contentType)
  metrics() {
    return metricsRegistry.metrics();
  }

  @Get('ops/status')
  @UseGuards(JwtAuthGuard, AdminGuard)
  status() {
    return this.ops.status();
  }
}
