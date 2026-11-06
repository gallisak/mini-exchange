import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { CommandStreamService } from './engine/command-stream.service';
import { InstrumentState } from './entities/instrument-state.entity';
import { Depth, aggregate } from './depth';
import { RedisService } from '../redis/redis.service';
import { PRICE_SCALE, QUANTITY_SCALE, normalizeDecimal } from '../common/decimal';
import { uuidV5 } from '../common/uuid';
import { currentTraceId } from '../observability/trace-context';
import { ordersAccepted } from '../observability/metrics';
import { intEnv } from '../common/env';
import { withTimeout } from '../common/with-timeout';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_TIMEOUT_MS = 2_000;
const ACTIVE_STATUSES: OrderStatus[] = ['open', 'partially_filled'];

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

export interface BookView extends Depth {
  instrument: string;
  seq: number;
}

export interface CancelAccepted {
  orderId: string;
  status: 'cancel_requested';
}

@Injectable()
export class OrdersService {
  private readonly historyLimit = intEnv('ORDER_HISTORY_LIMIT', 100);

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
    this.assertQueueAvailable();
    const price = normalizeDecimal(dto.price, PRICE_SCALE);
    const quantity = normalizeDecimal(dto.quantity, QUANTITY_SCALE);
    const fingerprint = [dto.instrument, dto.side, price, quantity].join('|');
    const orderId = uuidV5(`${ownerId}:${dto.instrument}:${idempotencyKey}`);

    const stored = await this.orders.findOne({ where: { id: orderId } });
    if (stored && fingerprintOf(stored) !== fingerprint) {
      throw new UnprocessableEntityException(IDEMPOTENCY_MISMATCH);
    }
    const recordKey = `orders:idempotency:${ownerId}:${idempotencyKey}`;
    const claimed = await this.queue(
      this.redis.client.set(recordKey, fingerprint, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX'),
    );
    if (claimed !== 'OK') {
      const previous = await this.queue(this.redis.client.get(recordKey));
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
      traceId: currentTraceId(),
    });
    ordersAccepted.inc({ instrument: dto.instrument });
    return { orderId, status: 'accepted' };
  }

  async cancelOrder(orderId: string, ownerId: string): Promise<CancelAccepted> {
    this.assertQueueAvailable();
    const order = await this.orders.findOne({ where: { id: orderId, ownerId } });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.status === 'cancelled') return { orderId, status: 'cancel_requested' };
    if (order.status === 'filled') {
      throw new ConflictException('Order is already filled');
    }
    await this.commands.append(order.instrument, {
      type: 'cancel',
      orderId,
      ownerId,
      traceId: currentTraceId(),
    });
    return { orderId, status: 'cancel_requested' };
  }

  private queue<T>(command: Promise<T>): Promise<T> {
    return withTimeout(command, IDEMPOTENCY_TIMEOUT_MS, 'Redis').catch(() => {
      throw new ServiceUnavailableException('The order queue did not answer, send the order again');
    });
  }

  private assertQueueAvailable(): void {
    if (!this.redis.isReady()) {
      throw new ServiceUnavailableException('Order queue is unavailable, try again shortly');
    }
  }

  async listOwn(ownerId: string): Promise<Order[]> {
    const [active, finished] = await Promise.all([
      this.orders.find({
        where: { ownerId, status: In(ACTIVE_STATUSES) },
        order: { createdAt: 'DESC' },
      }),
      this.orders.find({
        where: { ownerId, status: Not(In(ACTIVE_STATUSES)) },
        order: { createdAt: 'DESC' },
        take: this.historyLimit,
      }),
    ]);
    return [...active, ...finished].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
  }

  async getDepth(instrument: string): Promise<BookView> {
    return this.orders.manager.transaction('REPEATABLE READ', async (manager) => {
      const state = await manager.findOneBy(InstrumentState, { instrument });
      const open = await manager.find(Order, {
        where: { instrument, status: In(ACTIVE_STATUSES) },
      });
      return {
        instrument,
        seq: Number(state?.bookSeq ?? 0),
        ...aggregate({
          bids: open.filter((order) => order.side === 'buy'),
          asks: open.filter((order) => order.side === 'sell'),
        }),
      };
    });
  }
}
