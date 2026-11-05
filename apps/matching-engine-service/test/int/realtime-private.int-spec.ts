import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { AddressInfo } from 'net';
import { Socket, io } from 'socket.io-client';
import { WALLET_CHANNEL } from '../../src/orders/realtime/market-events';
import { RedisService } from '../../src/redis/redis.service';
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

  async function connect(user?: TestUser | string) {
    const token = typeof user === 'string' ? user : user?.token;
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

  it('disconnects a client when its access token expires', async () => {
    const alice = await register(app);
    const shortLived = new JwtService().sign(
      { sub: alice.userId, email: 'alice@example.com' },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '1s' },
    );
    const { socket } = await connect(shortLived);

    const reason = await new Promise<string>((resolve) => socket.once('disconnect', resolve));

    expect(reason).toBe('io server disconnect');
  });

  it('refuses a token without an expiry', async () => {
    const alice = await register(app);
    const endless = new JwtService().sign(
      { sub: alice.userId },
      { secret: process.env.JWT_ACCESS_SECRET },
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
    client.socket.on('resync', () => resyncs.push(true));
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

    await eventually(async () => expect(aliceResyncs).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(bobResyncs).toEqual([]);
  });

  it('tells the subscribers of a book whose delta could not be published to reload, and nobody else', async () => {
    const [alice, bob, carol] = [await register(app), await register(app), await register(app)];
    const [abcResyncs, defResyncs] = [await watching(bob, 'ABC'), await watching(carol, 'DEF')];
    failFirstPublishOf('book_delta');

    await submit(app, alice, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    await eventually(async () => expect(abcResyncs).toHaveLength(1));
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
});
