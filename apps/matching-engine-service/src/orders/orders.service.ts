import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Order } from './entities/order.entity';
import { OrderBookService } from './order-book.service';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { matchOrder } from './matcher';
import { PublicTrade, Trade } from './order-book.types';
import { PRICE_SCALE, QUANTITY_SCALE, normalizeDecimal } from '../common/decimal';

function toPublicTrade(trade: Trade): PublicTrade {
  return {
    id: trade.id,
    instrument: trade.instrument,
    buyOrderId: trade.buyOrderId,
    sellOrderId: trade.sellOrderId,
    price: trade.price,
    quantity: trade.quantity,
    executedAt: trade.executedAt,
  };
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly orderBook: OrderBookService,
  ) {}

  async submitOrder(dto: SubmitOrderDto, ownerId: string): Promise<PublicTrade[]> {
    const incoming: Order = {
      id: randomUUID(),
      ownerId,
      instrument: dto.instrument,
      side: dto.side,
      price: normalizeDecimal(dto.price, PRICE_SCALE),
      quantity: normalizeDecimal(dto.quantity, QUANTITY_SCALE),
      remainingQuantity: normalizeDecimal(dto.quantity, QUANTITY_SCALE),
      status: 'open',
      createdAt: new Date(),
    };

    const book = this.orderBook.snapshot(dto.instrument);
    const result = matchOrder(book, incoming);

    // Персистенція заявки в БД перед оновленням книги. Це асинхронна
    // операція — під час await виконання переходить іншим таскам у черзі
    // подій Node.js (наприклад, паралельному виклику submitOrder для
    // того самого інструмента).
    await this.orders.save(
      this.orders.create({
        ...incoming,
        remainingQuantity: result.restingOrder
          ? result.restingOrder.remainingQuantity
          : '0',
        status: result.restingOrder ? result.restingOrder.status : 'filled',
      }),
    );

    // Застосовуємо результат зіставлення (обчислений зі знімку книги,
    // знятого до await вище) до поточного стану книги інструмента.
    this.orderBook.replace(dto.instrument, {
      bids: result.updatedBids,
      asks: result.updatedAsks,
    });

    // TODO: опублікувати result.trades у чергу подій для settlement-service
    // (наприклад, Redis Streams / Kafka, партиційовано за instrument).
    // Поки що угоди лише повертаються викликачу й нікуди не публікуються.

    return result.trades.map(toPublicTrade);
  }

  async cancelOrder(orderId: string, instrument: string, ownerId: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId, ownerId } });
    if (!order) {
      throw new NotFoundException('Заявку не знайдено');
    }
    order.status = 'cancelled';
    order.remainingQuantity = '0';
    await this.orders.save(order);
    this.orderBook.removeOrder(instrument, orderId);
  }

  async listOwn(ownerId: string): Promise<Order[]> {
    return this.orders.find({ where: { ownerId } });
  }

  getDepth(instrument: string) {
    return this.orderBook.depth(instrument);
  }
}
