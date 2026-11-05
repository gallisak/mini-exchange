import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { AddressInfo } from 'net';
import { Socket, io } from 'socket.io-client';
import { createApp, eventually, register, resetState, submit } from './harness';

describe('real-time subscription of an engine', () => {
  let app: INestApplication;
  let socket: Socket | undefined;

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    socket?.disconnect();
    socket = undefined;
    await app.close();
    jest.restoreAllMocks();
  });

  it('keeps trying to subscribe when its first attempt failed, for example while Redis was starting', async () => {
    const psubscribe = Redis.prototype.psubscribe;
    let failed = false;
    jest.spyOn(Redis.prototype, 'psubscribe').mockImplementation(function (this: Redis, ...args: unknown[]) {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('Connection is closed.'));
      }
      return (psubscribe as (...input: unknown[]) => Promise<unknown>).apply(this, args);
    } as never);
    app = await createApp();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const deltas: unknown[] = [];
    socket.on('book_delta', (delta: unknown) => deltas.push(delta));
    await new Promise((resolve) => {
      socket!.once('book_snapshot', resolve);
      socket!.emit('subscribe', 'ABC');
    });
    const seller = await register(app);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await submit(app, seller, { side: 'sell', price: '100.00', quantity: '1' }).expect(202);

    expect(failed).toBe(true);
    await eventually(async () => expect(deltas).toHaveLength(1));
  });
});
