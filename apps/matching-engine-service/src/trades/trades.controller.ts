import { Controller, Get, Query } from '@nestjs/common';
import { PeriodQueryDto } from './dto/period-query.dto';
import { TradesService } from './trades.service';

@Controller('trades')
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Get('summary')
  summary(@Query() query: PeriodQueryDto) {
    return this.trades.summary(query.from, query.to);
  }
}
