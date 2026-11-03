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
import { IdempotencyKey } from './idempotency-key.decorator';

interface AuthenticatedRequest {
  user: { userId: string; email: string };
}

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submit(
    @Body() dto: SubmitOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.orders.submitOrder(dto, req.user.userId, idempotencyKey);
  }

  @Get()
  listOwn(@Request() req: AuthenticatedRequest) {
    return this.orders.listOwn(req.user.userId);
  }

  @Get('book')
  getDepth(@Query() query: InstrumentQueryDto) {
    return this.orders.getDepth(query.instrument);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Request() req: AuthenticatedRequest) {
    return this.orders.cancelOrder(id, req.user.userId);
  }
}
