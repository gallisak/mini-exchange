import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { OrdersService } from '../orders.service';
import { INSTRUMENTS } from '../../common/instruments';
import { corsOrigins, requireEnv } from '../../common/env';
import { RedisService, closeRedis } from '../../redis/redis.service';
import {
  MARKET_CHANNEL_PREFIX,
  MarketEvent,
  WALLET_CHANNEL,
  WalletChanged,
} from '../realtime/market-events';

const bookRoom = (instrument: string) => `book:${instrument}`;
const userRoom = (userId: string) => `user:${userId}`;

function parse<T>(message: string): T | null {
  try {
    return JSON.parse(message) as T;
  } catch {
    return null;
  }
}

interface Identity {
  userId: string;
  expiresAt: number;
}

@WebSocketGateway({ cors: { origin: corsOrigins() } })
export class OrdersGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnModuleDestroy
{
  private readonly logger = new Logger(OrdersGateway.name);
  private subscriber?: Redis;
  private readonly expiries = new Map<string, NodeJS.Timeout>();
  private readonly snapshots = new Map<string, { windowStart: number; count: number }>();

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly orders: OrdersService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      const token: unknown = socket.handshake.auth?.token;
      if (token === undefined) return next();
      const identity = this.identityFrom(token);
      if (!identity) return next(new Error('Unauthorized'));
      socket.data.userId = identity.userId;
      socket.data.expiresAt = identity.expiresAt;
      next();
    });

    this.subscriber = this.redis.createConnection();
    this.subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) =>
      this.fanOutMarket(message),
    );
    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel === WALLET_CHANNEL) this.fanOutWallet(message);
    });
    Promise.all([
      this.subscriber.psubscribe(`${MARKET_CHANNEL_PREFIX}*`),
      this.subscriber.subscribe(WALLET_CHANNEL),
    ]).catch((error: Error) =>
      this.logger.error(`Could not subscribe to real-time events: ${error.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.expiries.forEach((timer) => clearTimeout(timer));
    this.expiries.clear();
    await closeRedis(this.subscriber);
  }

  async handleConnection(client: Socket) {
    const userId: string | undefined = client.data.userId;
    if (userId) {
      const remainingMs = (client.data.expiresAt as number) - Date.now();
      this.expiries.set(
        client.id,
        setTimeout(() => client.disconnect(true), Math.max(remainingMs, 0)),
      );
      await client.join(userRoom(userId));
    }
    client.emit('connected', { message: 'ok', authenticated: Boolean(userId) });
  }

  handleDisconnect(client: Socket) {
    clearTimeout(this.expiries.get(client.id));
    this.expiries.delete(client.id);
    this.snapshots.delete(client.id);
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, instrument: unknown) {
    if (typeof instrument !== 'string' || !INSTRUMENTS.includes(instrument)) return;
    const retryAfterMs = this.snapshotRetryAfter(client.id);
    if (retryAfterMs > 0) {
      client.emit('rate_limited', { event: 'subscribe', retryAfterMs });
      return;
    }
    await client.join(bookRoom(instrument));
    client.emit('book_snapshot', await this.orders.getDepth(instrument));
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(client: Socket, instrument: unknown) {
    if (typeof instrument !== 'string' || !INSTRUMENTS.includes(instrument)) return;
    await client.leave(bookRoom(instrument));
  }

  private snapshotRetryAfter(socketId: string): number {
    const limit = Number(process.env.WS_SNAPSHOT_LIMIT ?? 10);
    const windowMs = Number(process.env.WS_SNAPSHOT_WINDOW_MS ?? 10_000);
    const now = Date.now();
    const usage = this.snapshots.get(socketId);
    if (!usage || now - usage.windowStart >= windowMs) {
      this.snapshots.set(socketId, { windowStart: now, count: 1 });
      return 0;
    }
    usage.count += 1;
    return usage.count > limit ? usage.windowStart + windowMs - now : 0;
  }

  private identityFrom(token: unknown): Identity | null {
    if (typeof token !== 'string') return null;
    try {
      const payload = this.jwt.verify<{ sub?: unknown; exp?: unknown }>(token, {
        secret: requireEnv('JWT_ACCESS_SECRET'),
      });
      if (typeof payload.sub !== 'string' || !isUUID(payload.sub)) return null;
      if (typeof payload.exp !== 'number') return null;
      return { userId: payload.sub, expiresAt: payload.exp * 1000 };
    } catch {
      return null;
    }
  }

  private fanOutMarket(message: string): void {
    const event = parse<MarketEvent>(message);
    if (event?.type === 'book_delta') {
      this.server.to(bookRoom(event.delta.instrument)).emit('book_delta', event.delta);
    }
    if (event?.type === 'book_heartbeat') {
      this.server
        .to(bookRoom(event.heartbeat.instrument))
        .emit('book_heartbeat', event.heartbeat);
    }
    if (event?.type === 'trades') {
      for (const trade of event.trades) {
        this.server.to(bookRoom(trade.instrument)).emit('trade', trade);
      }
    }
    if (event?.type === 'orders') {
      for (const { ownerId, ...order } of event.orders) {
        this.server.to(userRoom(ownerId)).emit('order', order);
      }
    }
  }

  private fanOutWallet(message: string): void {
    const event = parse<WalletChanged>(message);
    if (typeof event?.ownerId !== 'string' || typeof event.tradeId !== 'string') return;
    this.server.to(userRoom(event.ownerId)).emit('wallet', { tradeId: event.tradeId });
  }
}
