import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import { Socket, io } from 'socket.io-client';
import request from 'supertest';
import { createApp, eventually, register, resetState, submit } from './harness';

describe('trades feed', () => {
  let app: INestApplication;
  let socket: Socket | undefined;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
    await app.listen(0);
  });

  afterEach(async () => {
    socket?.disconnect();
    socket = undefined;
    await app.close();
  });

  const recent = (query: Record<string, string>) =>
    request(app.getHttpServer()).get('/trades').query(query);

  it('streams each trade to subscribers and lists the latest ones without the parties', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
    const streamed: { id: string }[] = [];
    socket.on('trade', (trade: { id: string }) => streamed.push(trade));
    await new Promise((resolve) => {
      socket!.once('book_snapshot', resolve);
      socket!.emit('subscribe', 'ABC');
    });
    const [seller, buyer] = [await register(app), await register(app)];

    for (const price of ['100.00', '101.00', '102.00']) {
      await submit(app, seller, { side: 'sell', price, quantity: '1' }).expect(202);
    }
    await submit(app, buyer, { side: 'buy', price: '102.00', quantity: '3' }).expect(202);
    await eventually(async () => expect(streamed).toHaveLength(3));

    const all = await recent({ instrument: 'ABC' }).expect(200);
    const latest = await recent({ instrument: 'ABC', limit: '2' }).expect(200);

    expect(all.body).toEqual([
      expect.objectContaining({ seq: 3, price: '102.00', quantity: '1.00000000' }),
      expect.objectContaining({ seq: 2, price: '101.00' }),
      expect.objectContaining({ seq: 1, price: '100.00' }),
    ]);
    expect(Object.keys(all.body[0]).sort()).toEqual(
      ['executedAt', 'id', 'instrument', 'price', 'quantity', 'seq'].sort(),
    );
    expect(latest.body).toEqual(all.body.slice(0, 2));
    expect(streamed).toEqual([...all.body].reverse());
  });

  it('rejects an unknown instrument or an unreasonable limit', async () => {
    await recent({ instrument: 'NOPE' }).expect(400);
    await recent({ instrument: 'ABC', limit: '0' }).expect(400);
    await recent({ instrument: 'ABC', limit: '1000' }).expect(400);
  });
});
