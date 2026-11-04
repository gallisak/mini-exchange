import { Controller, Get, Query } from '@nestjs/common';
import { PeriodQueryDto } from './dto/period-query.dto';
import { RecentTradesQueryDto } from './dto/recent-trades-query.dto';
import { TradesService } from './trades.service';

@Controller('trades')
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Get()
  recent(@Query() query: RecentTradesQueryDto) {
    return this.trades.recent(query.instrument, query.limit);
  }

  @Get('summary')
  summary(@Query() query: PeriodQueryDto) {
    return this.trades.summary(query.from, query.to);
  }
}
