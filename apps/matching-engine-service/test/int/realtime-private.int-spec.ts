import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { AddressInfo } from 'net';
import { Socket, io } from 'socket.io-client';
import request from 'supertest';
import { WALLET_CHANNEL, marketChannel } from '../../src/orders/realtime/market-events';
import { RedisService } from '../../src/redis/redis.service';
import { OrdersGateway } from '../../src/orders/gateway/orders.gateway';
import { SessionRevocations, revokedSessionKey } from '../../src/auth/session-revocations.service';
import { TestUser, createApp, eventually, register, resetState, submit } from './harness';

interface OrderEvent {
  id: string;
  status: string;
  remainingQuantity: string;
  ownerId?: string;
}

describe('private real-time updates', () => {
  let app: INestApplication;
  let url: string;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    await resetState();
    app = await createApp();
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
    await app.close();
  });

  async function ticketFor(user: TestUser): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/ws-ticket')
      .set('authorization', `Bearer ${user.token}`)
      .expect(200);
    return response.body.ticket;
  }

  async function connect(user?: TestUser | string) {
    const token = typeof user === 'string' ? user : user && (await ticketFor(user));
    const socket = io(url, { transports: ['websocket'], auth: token ? { token } : {} });
    sockets.push(socket);
    const events = { orders: [] as OrderEvent[], wallets: [] as unknown[] };
    socket.on('order', (order: OrderEvent) => events.orders.push(order));
    socket.on('wallet', (wallet: unknown) => events.wallets.push(wallet));
    await new Promise<void>((resolve, reject) => {
      socket.once('connected', () => resolve());
      socket.once('connect_error', reject);
    });
    return { socket, events };
  }

  it('tells each user about changes to their own orders and nobody else', async () => {
    const [alice, bob] = [await register(app), await register(app)];
    const [aliceClient, bobClient, anonymous] = [
      await connect(alice),
      await connect(bob),
      await connect(),
    ];

    const sell = await submit(app, alice, { side: 'sell', price: '100.00', quantity: '2' }).expect(202);
    await eventually(async () => expect(aliceClient.events.orders).toHaveLength(1));
    const buy = await submit(app, bob, { side: 'buy', price: '100.00', quantity: '2' }).expect(202);

    await eventually(async () => {
      expect(aliceClient.events.orders.map((o) => [o.id, o.status, o.remainingQuantity])).toEqual([
        [sell.body.orderId, 'open', '2.00000000'],
        [sell.body.orderId, 'filled', '0.00000000'],
      ]);
      expect(bobClient.events.orders.map((o) => [o.id, o.status])).toEqual([
        [buy.body.orderId, 'filled'],
      ]);
    });
    expect(aliceClient.events.orders.every((order) => order.ownerId === undefined)).toBe(true);
    expect(anonymous.events.orders).toEqual([]);
  });

  it('does not let a client subscribe itself to another user room', async () => {
    const [alice, bob] = [await register(app), await register(app)];
    const intruder = await connect(bob);
    intruder.socket.emit('subscribe', `user:${alice.userId}`);
    const witness = await connect(alice);

    await submit(app, alice, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    await eventually(async () => expect(witness.events.orders).toHaveLength(1));
    expect(intruder.events.orders).toEqual([]);
  });

  it('refuses a connection that presents an invalid token', async () => {
    await expect(connect('not-a-token')).rejects.toThrow('Unauthorized');
  });

  it('disconnects a client when the access token behind its ticket expires', async () => {
    const alice = await register(app);
    const shortLived = new JwtService().sign(
      { sub: alice.userId, until: Math.floor(Date.now() / 1000) + 1 },
      { secret: process.env.JWT_ACCESS_SECRET, audience: 'ws', expiresIn: '30s' },
    );
    const { socket } = await connect(shortLived);

    const reason = await new Promise<string>((resolve) => socket.once('disconnect', resolve));

    expect(reason).toBe('io server disconnect');
  });

  it('refuses a ticket of another type', async () => {
    const alice = await register(app);
    const claims = { sub: alice.userId, until: Math.floor(Date.now() / 1000) + 900, typ: 'access' };
    const mistyped = new JwtService().sign(claims, {
      secret: process.env.JWT_ACCESS_SECRET,
      audience: 'ws',
      expiresIn: '30s',
    });

    await expect(connect(mistyped)).rejects.toThrow('Unauthorized');
  });

  it('refuses a token without an expiry', async () => {
    const alice = await register(app);
    const endless = new JwtService().sign(
      { sub: alice.userId, until: Math.floor(Date.now() / 1000) + 900 },
      { secret: process.env.JWT_ACCESS_SECRET, audience: 'ws' },
    );

    await expect(connect(endless)).rejects.toThrow('Unauthorized');
  });

  it('forwards a wallet change from settlement to its owner only', async () => {
    const [alice, bob] = [await register(app), await register(app)];
    const [aliceClient, bobClient] = [await connect(alice), await connect(bob)];
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });

    await redis.publish(WALLET_CHANNEL, JSON.stringify({ ownerId: alice.userId, tradeId: 'trade-1' }));
    await redis.quit();

    await eventually(async () => expect(aliceClient.events.wallets).toEqual([{ tradeId: 'trade-1' }]));
    expect(bobClient.events.wallets).toEqual([]);
  });

  function failFirstPublishOf(type: string) {
    const client = app.get(RedisService).client;
    const publish = client.publish.bind(client);
    let failed = false;
    jest.spyOn(client, 'publish').mockImplementation(((channel: string, message: string) => {
      if (!failed && JSON.parse(message).type === type) {
        failed = true;
        return Promise.reject(new Error('Connection is closed.'));
      }
      return publish(channel, message);
    }) as never);
  }

  async function watching(user: TestUser, instrument?: string) {
    const client = await connect(user);
    const resyncs: unknown[] = [];
    client.socket.on('resync', (scope: unknown) => resyncs.push(scope));
    if (instrument) {
      await new Promise((resolve) => {
        client.socket.once('book_snapshot', resolve);
        client.socket.emit('subscribe', instrument);
      });
    }
    return resyncs;
  }

  it('tells the owner of an order update that could not be published to reload, and nobody else', async () => {
    const [alice, bob] = [await register(app), await register(app)];
    const [aliceResyncs, bobResyncs] = [await watching(alice), await watching(bob, 'DEF')];
    failFirstPublishOf('orders');

    await submit(app, alice, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    await eventually(async () => expect(aliceResyncs).toEqual([{ orders: true }]));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(bobResyncs).toEqual([]);
  });

  it('tells the subscribers of a book whose delta could not be published to reload, and nobody else', async () => {
    const [alice, bob, carol] = [await register(app), await register(app), await register(app)];
    const [abcResyncs, defResyncs] = [await watching(bob, 'ABC'), await watching(carol, 'DEF')];
    failFirstPublishOf('book_delta');

    await submit(app, alice, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    await eventually(async () => expect(abcResyncs).toEqual([{ instrument: 'ABC' }]));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(defResyncs).toEqual([]);
  });

  it('tells connected clients to reload once its Redis subscription was down, since updates may be lost', async () => {
    const alice = await register(app);
    const { socket, events } = await connect(alice);
    const resyncs: unknown[] = [];
    socket.on('resync', () => resyncs.push(true));
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });

    await redis.client('KILL', 'TYPE', 'pubsub');
    await redis.quit();

    await eventually(async () => expect(resyncs).toHaveLength(1));
    await submit(app, alice, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(events.orders).toHaveLength(1));
  });

  it('takes only a real-time ticket for the connection, not an API access token', async () => {
    const alice = await register(app);
    const ticket = await ticketFor(alice);

    await expect(connect(alice.token)).rejects.toThrow('Unauthorized');
    await expect(connect(ticket)).resolves.toBeDefined();
  });

  it('tells every signed-in client to reload its orders when a book changed owner', async () => {
    const [alice, bob] = [await register(app), await register(app)];
    const [aliceResyncs, bobResyncs] = [await watching(alice), await watching(bob, 'ABC')];
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });

    await redis.publish(
      marketChannel('resync'),
      JSON.stringify({ type: 'resync', resync: { instruments: ['ABC'], owners: [], allOwners: true } }),
    );
    await redis.quit();

    await eventually(async () => {
      expect(aliceResyncs).toEqual([{ orders: true }]);
      expect(bobResyncs).toEqual(expect.arrayContaining([{ instrument: 'ABC' }, { orders: true }]));
    });
  });

  it('accepts an access token for the connection only while a rollout asks it to', async () => {
    await app.close();
    process.env.WS_ACCEPT_ACCESS_TOKENS = 'true';
    try {
      app = await createApp();
      await app.listen(0);
      url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const alice = await register(app);

      await expect(connect(alice.token)).resolves.toBeDefined();
      const refreshLike = new JwtService().sign(
        { sub: alice.userId, jti: alice.userId },
        { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
      );
      await expect(connect(refreshLike)).rejects.toThrow('Unauthorized');
    } finally {
      delete process.env.WS_ACCEPT_ACCESS_TOKENS;
    }
  });

  it('disconnects the real-time connections of a session that logs out and refuses its unused tickets', async () => {
    const alice = await register(app);
    const spare = await ticketFor(alice);
    const { socket } = await connect(alice);
    const disconnected = new Promise<string>((resolve) => {
      socket.once('disconnect', resolve);
      setTimeout(() => resolve('still connected'), 3000);
    });

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('authorization', `Bearer ${alice.token}`)
      .expect(204);

    expect(await disconnected).toBe('io server disconnect');
    await expect(connect(spare)).rejects.toThrow('Unauthorized');
  });

  it('closes the connections of a session that logged out while the Redis subscription was down', async () => {
    const alice = await register(app);
    const { socket } = await connect(alice);
    const subscriber = (app.get(OrdersGateway) as unknown as { subscriber: Redis }).subscriber;
    let refused!: () => void;
    const subscriptionDown = new Promise<void>((resolve) => (refused = resolve));
    jest.spyOn(subscriber, 'subscribe').mockImplementationOnce((async () => {
      refused();
      throw new Error('Connection is closed.');
    }) as never);
    const disconnected = new Promise<string>((resolve) => {
      socket.once('disconnect', resolve);
      setTimeout(() => resolve('still connected'), 8000);
    });
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    await redis.client('KILL', 'TYPE', 'pubsub');
    await redis.quit();
    await subscriptionDown;

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('authorization', `Bearer ${alice.token}`)
      .expect(204);

    expect(await disconnected).toBe('io server disconnect');
  });

  it('keeps connections open while it cannot check which sessions ended after a reconnect, and closes only the ended ones once it can', async () => {
    const bob = await register(app);
    const alice = await register(app);
    const bobSocket = (await connect(bob)).socket;
    const aliceSocket = (await connect(alice)).socket;
    const sessionOf = (user: TestUser) =>
      (JSON.parse(Buffer.from(user.token.split('.')[1], 'base64url').toString()) as { sid: string }).sid;
    const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    await redis.set(revokedSessionKey(sessionOf(alice)), '1', 'PX', 60_000);
    const check = jest
      .spyOn(app.get(SessionRevocations), 'isRevoked')
      .mockRejectedValueOnce(new ServiceUnavailableException('Could not check the session, try again'));
    const bobDropped = jest.fn();
    bobSocket.on('disconnect', bobDropped);
    const aliceDropped = new Promise<string>((resolve) => {
      aliceSocket.once('disconnect', resolve);
      setTimeout(() => resolve('still connected'), 8000);
    });

    await redis.client('KILL', 'TYPE', 'pubsub');
    await redis.quit();

    expect(await aliceDropped).toBe('io server disconnect');
    expect(check.mock.calls.length).toBeGreaterThan(1);
    expect(bobDropped).not.toHaveBeenCalled();
    expect(bobSocket.connected).toBe(true);
  });
});
