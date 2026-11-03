import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { InstrumentQueryDto } from './dto/instrument-query.dto';

interface AuthenticatedRequest {
  user: { userId: string; email: string };
}

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  submit(@Body() dto: SubmitOrderDto, @Request() req: AuthenticatedRequest) {
    return this.orders.submitOrder(dto, req.user.userId);
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
  cancel(@Param('id') id: string, @Query() query: InstrumentQueryDto) {
    return this.orders.cancelOrder(id, query.instrument);
  }
}
