import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { PeriodQueryDto } from './dto/period-query.dto';
import { RecentTradesQueryDto } from './dto/recent-trades-query.dto';
import { TradesService } from './trades.service';

@ApiTags('trades')
@Controller('trades')
@UseGuards(RateLimitGuard)
@RateLimit('PUBLIC')
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
