import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { TradesService } from './trades.service';
import { SettleTradeDto } from './dto/settle-trade.dto';
import { InternalKeyGuard } from '../auth/internal-key.guard';

@ApiTags('trades')
@Controller('trades')
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Post('settle')
  @ApiSecurity('internal-key')
  @HttpCode(200)
  @UseGuards(InternalKeyGuard)
  settle(@Body() dto: SettleTradeDto) {
    return this.trades.settle(dto);
  }
}
