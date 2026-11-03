import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { CommandStreamService } from './engine/command-stream.service';
import { BookSnapshot } from './order-book.types';
import { sortByPriceTimePriority } from './matcher';
import { RedisService } from '../redis/redis.service';
import { PRICE_SCALE, QUANTITY_SCALE, normalizeDecimal } from '../common/decimal';
import { uuidV5 } from '../common/uuid';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_MISMATCH = 'Idempotency-Key was already used for a different order';

function fingerprintOf(order: Order): string {
  return [
    order.instrument,
    order.side,
    normalizeDecimal(order.price, PRICE_SCALE),
    normalizeDecimal(order.quantity, QUANTITY_SCALE),
  ].join('|');
}

export interface OrderAccepted {
  orderId: string;
  status: 'accepted';
}

export interface CancelAccepted {
  orderId: string;
  status: 'cancel_requested';
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly commands: CommandStreamService,
    private readonly redis: RedisService,
  ) {}

  async submitOrder(
    dto: SubmitOrderDto,
    ownerId: string,
    idempotencyKey: string,
  ): Promise<OrderAccepted> {
    const price = normalizeDecimal(dto.price, PRICE_SCALE);
    const quantity = normalizeDecimal(dto.quantity, QUANTITY_SCALE);
    const fingerprint = [dto.instrument, dto.side, price, quantity].join('|');
    const orderId = uuidV5(`${ownerId}:${dto.instrument}:${idempotencyKey}`);

    const stored = await this.orders.findOne({ where: { id: orderId } });
    if (stored && fingerprintOf(stored) !== fingerprint) {
      throw new UnprocessableEntityException(IDEMPOTENCY_MISMATCH);
    }
    const recordKey = `orders:idempotency:${ownerId}:${idempotencyKey}`;
    const claimed = await this.redis.client.set(
      recordKey,
      fingerprint,
      'EX',
      IDEMPOTENCY_TTL_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') {
      const previous = await this.redis.client.get(recordKey);
      if (previous !== null && previous !== fingerprint) {
        throw new UnprocessableEntityException(IDEMPOTENCY_MISMATCH);
      }
    }

    await this.commands.append(dto.instrument, {
      type: 'submit',
      orderId,
      ownerId,
      side: dto.side,
      price,
      quantity,
    });
    return { orderId, status: 'accepted' };
  }

  async cancelOrder(orderId: string, ownerId: string): Promise<CancelAccepted> {
    const order = await this.orders.findOne({ where: { id: orderId, ownerId } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.status === 'filled' || order.status === 'cancelled') {
      throw new ConflictException(`Order is already ${order.status}`);
    }
    await this.commands.append(order.instrument, { type: 'cancel', orderId, ownerId });
    return { orderId, status: 'cancel_requested' };
  }

  async listOwn(ownerId: string): Promise<Order[]> {
    return this.orders.find({ where: { ownerId }, order: { createdAt: 'DESC' } });
  }

  async getDepth(instrument: string): Promise<BookSnapshot> {
    const open = await this.orders.find({
      where: { instrument, status: In(['open', 'partially_filled']) },
    });
    return {
      bids: sortByPriceTimePriority(
        open.filter((order) => order.side === 'buy'),
        'buy',
      ),
      asks: sortByPriceTimePriority(
        open.filter((order) => order.side === 'sell'),
        'sell',
      ),
    };
  }
}
