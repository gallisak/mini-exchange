import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { OrdersService } from '../orders.service';
import { INSTRUMENTS } from '../../common/instruments';
import { RedisService } from '../../redis/redis.service';
import { MARKET_CHANNEL_PREFIX, MarketEvent } from '../realtime/market-events';

const bookRoom = (instrument: string) => `book:${instrument}`;
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

@WebSocketGateway({ cors: { origin: corsOrigins } })
export class OrdersGateway implements OnGatewayConnection, OnGatewayInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersGateway.name);
  private subscriber?: Redis;

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly orders: OrdersService,
    private readonly redis: RedisService,
  ) {}

  afterInit(): void {
    this.subscriber = this.redis.createConnection();
    this.subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) =>
      this.fanOut(message),
    );
    this.subscriber
      .psubscribe(`${MARKET_CHANNEL_PREFIX}*`)
      .catch((error: Error) => this.logger.error(`Could not subscribe to market events: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }

  handleConnection(client: Socket) {
    client.emit('connected', { message: 'ok' });
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, instrument: unknown) {
    if (typeof instrument !== 'string' || !INSTRUMENTS.includes(instrument)) return;
    await client.join(bookRoom(instrument));
    client.emit('book_snapshot', await this.orders.getDepth(instrument));
  }

  private fanOut(message: string): void {
    let event: MarketEvent;
    try {
      event = JSON.parse(message);
    } catch {
      return;
    }
    if (event.type === 'book_delta') {
      this.server.to(bookRoom(event.delta.instrument)).emit('book_delta', event.delta);
    }
    if (event.type === 'book_heartbeat') {
      this.server
        .to(bookRoom(event.heartbeat.instrument))
        .emit('book_heartbeat', event.heartbeat);
    }
  }
}
