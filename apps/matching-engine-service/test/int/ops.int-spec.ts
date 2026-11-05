import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { setAdmin } from '../../src/tools/grant-admin';
import { createApp, eventually, listOrders, register, resetState, submit } from './harness';

describe('operations endpoints', () => {
  describe('with every dependency up', () => {
    let app: INestApplication;

    beforeEach(async () => {
      await resetState();
      app = await createApp();
    });

    afterEach(async () => {
      await app.close();
    });

    const http = () => request(app.getHttpServer());

    it('reports itself healthy', async () => {
      const response = await http().get('/health').expect(200);

      expect(response.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });

    it('exposes Prometheus metrics for requests, orders and trades', async () => {
      const [seller, buyer] = [await register(app), await register(app)];
      await submit(app, seller, { side: 'sell', price: '10.00', quantity: '1' }).expect(202);
      await submit(app, buyer, { side: 'buy', price: '10.00', quantity: '1' }).expect(202);
      await eventually(async () =>
        expect((await listOrders(app, buyer))[0]?.status).toBe('filled'),
      );

      const response = await http().get('/metrics').expect(200);

      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toMatch(/orders_accepted_total\{instrument="ABC"\} \d+/);
      expect(response.text).toMatch(/trades_executed_total\{instrument="ABC"\} \d+/);
      expect(response.text).toContain('http_requests_total{method="POST",route="/orders",status="202"}');
    });

    it('shows instrument ownership and backlog to admins only', async () => {
      const user = await register(app);
      const credentials = { email: 'ops@example.com', password: 'password123' };
      await http().post('/auth/register').send(credentials).expect(201);
      await setAdmin(app.get(DataSource), credentials.email, true);
      const admin = (await http().post('/auth/login').send(credentials).expect(200)).body
        .accessToken as string;
      await submit(app, user, { side: 'sell', price: '10.00', quantity: '1' }).expect(202);
      await eventually(async () => expect(await listOrders(app, user)).toHaveLength(1));

      await http().get('/ops/status').expect(401);
      await http().get('/ops/status').set('authorization', `Bearer ${user.token}`).expect(403);
      const response = await http()
        .get('/ops/status')
        .set('authorization', `Bearer ${admin}`)
        .expect(200);

      expect(response.body.instance).toMatch(/^engine-test:/);
      expect(response.body.outboxPending).toBe(0);
      expect(response.body.instruments.find((row: { instrument: string }) => row.instrument === 'ABC')).toEqual(
        expect.objectContaining({
          owner: response.body.instance,
          ownedHere: true,
          bookSeq: 1,
          commandStreamLength: 1,
          commandsBehind: 0,
          stuck: null,
        }),
      );
    });
  });

  describe('with Redis unreachable', () => {
    let app: INestApplication;
    const port = process.env.REDIS_PORT;

    beforeEach(async () => {
      await resetState();
      process.env.REDIS_PORT = '1';
      app = await createApp();
    });

    afterEach(async () => {
      await app.close();
      process.env.REDIS_PORT = port;
    });

    it('answers 503 instead of failing, hanging or skipping its rate limits', async () => {
      const token = new JwtService().sign(
        { sub: randomUUID(), email: 'trader@example.com' },
        { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '5m' },
      );

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'trader@example.com', password: 'password123' });
      const order = await request(app.getHttpServer())
        .post('/orders')
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', randomUUID())
        .send({ instrument: 'ABC', side: 'buy', price: '1.00', quantity: '1' });
      const health = await request(app.getHttpServer()).get('/health');

      expect(login.status).toBe(503);
      expect(order.status).toBe(503);
      expect(health.status).toBe(503);
      expect(health.body.checks).toEqual({ database: 'up', redis: 'down' });
    });
  });
});
