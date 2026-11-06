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
import proxyAddr from 'proxy-addr';
import { Server, Socket } from 'socket.io';
import { OrdersService } from '../orders.service';
import { WS_AUDIENCE } from '../../auth/auth.service';
import { LOGOUT_CHANNEL, SessionRevocations } from '../../auth/session-revocations.service';
import { INSTRUMENTS } from '../../common/instruments';
import { corsOrigins, intEnv, requireEnv, trustedProxies } from '../../common/env';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { rateLimitPolicy } from '../../rate-limit/rate-limit.policies';
import { RedisService, closeRedis } from '../../redis/redis.service';
import {
  MARKET_CHANNEL_PREFIX,
  MarketEvent,
  WALLET_CHANNEL,
  WalletChanged,
} from '../realtime/market-events';

const SUBSCRIBE_RETRY_MS = 1000;
const bookRoom = (instrument: string) => `book:${instrument}`;
const userRoom = (userId: string) => `user:${userId}`;
const sessionRoom = (sessionId: string) => `session:${sessionId}`;

const isInstrument = (value: unknown): value is string =>
  typeof value === 'string' && INSTRUMENTS.includes(value);

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
  sessionId?: string;
}

@WebSocketGateway({ cors: { origin: corsOrigins() } })
export class OrdersGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, OnModuleDestroy
{
  private readonly logger = new Logger(OrdersGateway.name);
  private subscriber?: Redis;
  private subscribeRetry?: NodeJS.Timeout;
  private closing = false;
  private readonly expiries = new Map<string, NodeJS.Timeout>();
  private readonly snapshots = new Map<string, { windowStart: number; count: number }>();
  private readonly trust = proxyAddr.compile(trustedProxies());
  private readonly snapshotLimit = intEnv('WS_SNAPSHOT_LIMIT', 10);
  private readonly snapshotWindowMs = intEnv('WS_SNAPSHOT_WINDOW_MS', 10_000);
  private readonly acceptAccessTokens = process.env.WS_ACCEPT_ACCESS_TOKENS === 'true';

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly orders: OrdersService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly limiter: RateLimitService,
    private readonly revocations: SessionRevocations,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      const token: unknown = socket.handshake.auth?.token;
      if (token === undefined) return next();
      const identity = this.identityFrom(token);
      if (!identity) return next(new Error('Unauthorized'));
      this.stillSignedIn(identity).then(
        (signedIn) => {
          if (!signedIn) return next(new Error('Unauthorized'));
          socket.data.userId = identity.userId;
          socket.data.expiresAt = identity.expiresAt;
          socket.data.sessionId = identity.sessionId;
          next();
        },
        () => next(new Error('Unavailable')),
      );
    });

    const subscriber = this.redis.createConnection({ autoResubscribe: false });
    this.subscriber = subscriber;
    let subscribedBefore = false;
    let missedUpdates = false;
    const subscribe = () => {
      clearTimeout(this.subscribeRetry);
      Promise.all([
        subscriber.psubscribe(`${MARKET_CHANNEL_PREFIX}*`),
        subscriber.subscribe(WALLET_CHANNEL, LOGOUT_CHANNEL),
      ]).then(
        () => {
          if (subscribedBefore || missedUpdates) {
            this.logger.warn('Real-time subscription restored, telling clients to reload');
            server.emit('resync', {});
            void this.closeEndedSessions();
          }
          subscribedBefore = true;
          missedUpdates = false;
        },
        (error: Error) => {
          missedUpdates = true;
          this.logger.error(`Could not subscribe to real-time events, retrying: ${error.message}`);
          if (!this.closing) this.subscribeRetry = setTimeout(subscribe, SUBSCRIBE_RETRY_MS);
        },
      );
    };
    subscriber.on('ready', subscribe);
    subscriber.on('pmessage', (_pattern: string, _channel: string, message: string) =>
      this.fanOutMarket(message),
    );
    subscriber.on('message', (channel: string, message: string) => {
      if (channel === WALLET_CHANNEL) this.fanOutWallet(message);
      if (channel === LOGOUT_CHANNEL) this.server.in(sessionRoom(message)).disconnectSockets(true);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearTimeout(this.subscribeRetry);
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
      const sessionId: string | undefined = client.data.sessionId;
      await client.join(sessionId ? [userRoom(userId), sessionRoom(sessionId)] : userRoom(userId));
      if (sessionId && (await this.revocations.isRevoked(sessionId).catch(() => false))) {
        client.disconnect(true);
        return;
      }
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
    const retryAfterMs = Math.max(
      this.snapshotRetryAfter(client.id),
      await this.addressRetryAfter(client),
    );
    if (retryAfterMs > 0) {
      client.emit('rate_limited', { event: 'subscribe', instrument, retryAfterMs });
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

  private async addressRetryAfter(client: Socket): Promise<number> {
    const policy = rateLimitPolicy('SNAPSHOT');
    try {
      if (!this.limiter.isAvailable()) return 0;
      const address = proxyAddr(client.request, this.trust);
      const result = await this.limiter.hit(`SNAPSHOT:${address}`, policy.limit, policy.windowMs);
      return result.allowed ? 0 : result.retryAfterMs;
    } catch {
      return 0;
    }
  }

  private snapshotRetryAfter(socketId: string): number {
    const limit = this.snapshotLimit;
    const windowMs = this.snapshotWindowMs;
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
    return (
      this.ticketIdentity(token) ?? (this.acceptAccessTokens ? this.accessTokenIdentity(token) : null)
    );
  }

  private ticketIdentity(token: string): Identity | null {
    try {
      const payload = this.jwt.verify<{ sub?: unknown; exp?: unknown; until?: unknown; sid?: unknown }>(
        token,
        { secret: requireEnv('JWT_ACCESS_SECRET'), audience: WS_AUDIENCE },
      );
      if (typeof payload.sub !== 'string' || !isUUID(payload.sub)) return null;
      if (typeof payload.exp !== 'number' || typeof payload.until !== 'number') return null;
      const sessionId = typeof payload.sid === 'string' ? payload.sid : undefined;
      return { userId: payload.sub, expiresAt: payload.until * 1000, sessionId };
    } catch {
      return null;
    }
  }

  private accessTokenIdentity(token: string): Identity | null {
    try {
      const payload = this.jwt.verify<{ sub?: unknown; exp?: unknown; aud?: unknown; sid?: unknown }>(token, {
        secret: requireEnv('JWT_ACCESS_SECRET'),
      });
      if (payload.aud !== undefined || typeof payload.sub !== 'string' || !isUUID(payload.sub)) {
        return null;
      }
      if (typeof payload.exp !== 'number') return null;
      const sessionId = typeof payload.sid === 'string' ? payload.sid : undefined;
      return { userId: payload.sub, expiresAt: payload.exp * 1000, sessionId };
    } catch {
      return null;
    }
  }

  private async closeEndedSessions(): Promise<void> {
    const sockets = await this.server.local.fetchSockets();
    const sessions = [...new Set(sockets.map((socket) => socket.data.sessionId as string | undefined))];
    for (const sessionId of sessions) {
      if (!sessionId || !(await this.revocations.isRevoked(sessionId).catch(() => false))) continue;
      this.server.local.in(sessionRoom(sessionId)).disconnectSockets(true);
    }
  }

  private async stillSignedIn(identity: Identity): Promise<boolean> {
    return !identity.sessionId || !(await this.revocations.isRevoked(identity.sessionId));
  }

  private fanOutMarket(message: string): void {
    try {
      this.routeMarket(parse<MarketEvent>(message));
    } catch (error) {
      this.logger.warn(`Ignoring a malformed market message: ${(error as Error).message}`);
    }
  }

  private routeMarket(event: MarketEvent | null): void {
    if (typeof event !== 'object' || event === null) return;
    if (event.type === 'book_delta' && isInstrument(event.delta?.instrument)) {
      this.server.to(bookRoom(event.delta.instrument)).emit('book_delta', event.delta);
    }
    if (event.type === 'book_heartbeat' && isInstrument(event.heartbeat?.instrument)) {
      this.server.to(bookRoom(event.heartbeat.instrument)).emit('book_heartbeat', event.heartbeat);
    }
    if (event.type === 'trades' && Array.isArray(event.trades)) {
      for (const trade of event.trades) {
        if (isInstrument(trade?.instrument)) this.server.to(bookRoom(trade.instrument)).emit('trade', trade);
      }
    }
    if (event.type === 'orders' && Array.isArray(event.orders)) {
      for (const order of event.orders) {
        if (typeof order?.ownerId !== 'string') continue;
        const { ownerId, ...update } = order;
        this.server.to(userRoom(ownerId)).emit('order', update);
      }
    }
    if (event.type === 'resync') {
      const { instruments, owners, allOwners } = event.resync ?? {};
      for (const instrument of Array.isArray(instruments) ? instruments : []) {
        if (isInstrument(instrument)) this.server.to(bookRoom(instrument)).emit('resync', { instrument });
      }
      const rooms = (Array.isArray(owners) ? owners : [])
        .filter((owner): owner is string => typeof owner === 'string')
        .map(userRoom);
      if (allOwners === true) this.server.emit('resync', { orders: true });
      else if (rooms.length > 0) this.server.to(rooms).emit('resync', { orders: true });
    }
  }

  private fanOutWallet(message: string): void {
    const event = parse<WalletChanged>(message);
    if (typeof event?.ownerId !== 'string' || typeof event.tradeId !== 'string') return;
    this.server.to(userRoom(event.ownerId)).emit('wallet', { tradeId: event.tradeId });
  }
}
