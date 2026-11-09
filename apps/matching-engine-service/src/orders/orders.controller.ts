import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { InstrumentQueryDto } from './dto/instrument-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { IdempotencyKey } from './idempotency-key.decorator';
import { RateLimit, RateLimitGuard } from '../rate-limit/rate-limit.guard';

interface AuthenticatedRequest {
  user: { userId: string; email: string };
}

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit('ORDER')
  @HttpCode(HttpStatus.ACCEPTED)
  submit(
    @Body() dto: SubmitOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.orders.submitOrder(dto, req.user.userId, idempotencyKey);
  }

  @Get()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listOwn(@Request() req: AuthenticatedRequest) {
    return this.orders.listOwn(req.user.userId);
  }

  @Get('history')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listHistory(@Query() query: HistoryQueryDto, @Request() req: AuthenticatedRequest) {
    return this.orders.listHistory(req.user.userId, new Date(query.before), query.beforeId);
  }

  @Get('book')
  @UseGuards(RateLimitGuard)
  @RateLimit('PUBLIC')
  getDepth(@Query() query: InstrumentQueryDto) {
    return this.orders.getDepth(query.instrument);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @RateLimit('ORDER')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Request() req: AuthenticatedRequest) {
    return this.orders.cancelOrder(id, req.user.userId);
  }
}
