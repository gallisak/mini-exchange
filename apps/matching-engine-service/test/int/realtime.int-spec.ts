import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import { Socket, io } from 'socket.io-client';
import request from 'supertest';
import { createApp, eventually, listOrders, register, resetState, submit } from './harness';

interface Level {
  price: string;
  quantity: string;
  orders: number;
}

interface Snapshot {
  instrument: string;
  seq: number;
  bids: Level[];
  asks: Level[];
}

function nextEvent<T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${event} within ${timeoutMs} ms`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function collect<T>(socket: Socket, event: string): T[] {
  const received: T[] = [];
  socket.on(event, (payload: T) => received.push(payload));
  return received;
}

describe('real-time order book', () => {
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

  async function subscribed(): Promise<{ socket: Socket; snapshot: Snapshot }> {
    const socket = io(url, { transports: ['websocket'] });
    sockets.push(socket);
    const snapshot = nextEvent<Snapshot>(socket, 'book_snapshot');
    socket.emit('subscribe', 'ABC');
    return { socket, snapshot: await snapshot };
  }

  it('sends a subscriber the aggregated book with a sequence number and no owners', async () => {
    const seller = await register(app);
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '2' }).expect(202);
    await submit(app, seller, { side: 'sell', price: '101.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(await listOrders(app, seller)).toHaveLength(3));

    const { snapshot } = await subscribed();

    expect(snapshot).toEqual({
      instrument: 'ABC',
      seq: expect.any(Number),
      bids: [],
      asks: [
        { price: '100.00', quantity: '3.00000000', orders: 2 },
        { price: '101.00', quantity: '1.00000000', orders: 1 },
      ],
    });
    expect(snapshot.seq).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain(seller.userId);
  });

  it('pushes every change of the book to subscribers as numbered deltas', async () => {
    const seller = await register(app);
    const buyer = await register(app);
    const { socket, snapshot } = await subscribed();
    const deltas = collect<{ instrument: string; seq: number; changes: unknown[] }>(
      socket,
      'book_delta',
    );

    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '2' }).expect(202);
    await eventually(async () => expect(deltas).toHaveLength(1));
    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '0.5' }).expect(202);
    await eventually(async () => expect(deltas).toHaveLength(2));
    await submit(app, buyer, { side: 'buy', price: '99.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(deltas).toHaveLength(3));

    expect(snapshot.seq).toBe(0);
    expect(deltas).toEqual([
      {
        instrument: 'ABC',
        seq: 1,
        changes: [{ side: 'sell', price: '100.00', quantity: '2.00000000', orders: 1 }],
      },
      {
        instrument: 'ABC',
        seq: 2,
        changes: [{ side: 'sell', price: '100.00', quantity: '1.50000000', orders: 1 }],
      },
      {
        instrument: 'ABC',
        seq: 3,
        changes: [{ side: 'buy', price: '99.00', quantity: '1.00000000', orders: 1 }],
      },
    ]);
  });

  it('tells subscribers a level is gone when its last order leaves the book', async () => {
    const seller = await register(app);
    const buyer = await register(app);
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(await listOrders(app, seller)).toHaveLength(1));
    const { socket, snapshot } = await subscribed();
    const delta = nextEvent<{ seq: number; changes: unknown[] }>(socket, 'book_delta');

    await submit(app, buyer, { side: 'buy', price: '100.00', quantity: '1' }).expect(202);

    expect(await delta).toEqual({
      instrument: 'ABC',
      seq: snapshot.seq + 1,
      changes: [{ side: 'sell', price: '100.00', quantity: '0.00000000', orders: 0 }],
    });
  });

  it('keeps announcing the current sequence number so a client that lost the last delta notices', async () => {
    const seller = await register(app);
    const { socket, snapshot } = await subscribed();
    const delta = nextEvent<{ seq: number }>(socket, 'book_delta');
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    const { seq } = await delta;

    const heartbeat = await nextEvent<{ instrument: string; seq: number }>(socket, 'book_heartbeat');

    expect(seq).toBe(snapshot.seq + 1);
    expect(heartbeat).toEqual({ instrument: 'ABC', seq });
  });

  it('stops sending a book to a client that unsubscribed from it', async () => {
    const seller = await register(app);
    const { socket } = await subscribed();
    const deltas = collect(socket, 'book_delta');
    socket.emit('unsubscribe', 'ABC');
    await new Promise((resolve) => setTimeout(resolve, 200));

    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(await listOrders(app, seller)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(deltas).toEqual([]);
  });

  it('serves the same snapshot over REST to anyone without exposing owners', async () => {
    const seller = await register(app);
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);
    await eventually(async () => expect(await listOrders(app, seller)).toHaveLength(1));

    const response = await request(app.getHttpServer()).get('/orders/book').query({ instrument: 'ABC' });

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(seller.userId);
    expect(response.body).toEqual((await subscribed()).snapshot);
  });
});
