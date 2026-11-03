import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { buildDataSourceOptions } from '../../src/database/data-source';

export interface TestUser {
  token: string;
  userId: string;
}

export interface OrderBody {
  instrument?: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
}

export interface OrderRow {
  id: string;
  ownerId: string;
  instrument: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
  remainingQuantity: string;
  status: string;
}

export async function resetState(): Promise<void> {
  const dataSource = new DataSource(buildDataSourceOptions());
  await dataSource.initialize();
  const tables: { tablename: string }[] = await dataSource.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  );
  if (tables.length > 0) {
    await dataSource.query(
      `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
  await dataSource.destroy();

  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  });
  await redis.flushdb();
  await redis.quit();
}

export async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

export async function register(app: INestApplication): Promise<TestUser> {
  const response = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email: `user-${randomUUID()}@example.com`, password: 'password123' })
    .expect(201);
  const token: string = response.body.accessToken;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return { token, userId: payload.sub };
}

export function submit(
  app: INestApplication,
  user: TestUser,
  body: OrderBody,
  idempotencyKey: string = randomUUID(),
) {
  return request(app.getHttpServer())
    .post('/orders')
    .set('authorization', `Bearer ${user.token}`)
    .set('idempotency-key', idempotencyKey)
    .send({ instrument: 'ABC', ...body });
}

export function cancel(app: INestApplication, user: TestUser, orderId: string, query = '') {
  return request(app.getHttpServer())
    .delete(`/orders/${orderId}${query}`)
    .set('authorization', `Bearer ${user.token}`);
}

export async function listOrders(app: INestApplication, user: TestUser): Promise<OrderRow[]> {
  const response = await request(app.getHttpServer())
    .get('/orders')
    .set('authorization', `Bearer ${user.token}`)
    .expect(200);
  return response.body;
}

export async function book(
  app: INestApplication,
  user: TestUser,
  instrument = 'ABC',
): Promise<{ bids: OrderRow[]; asks: OrderRow[] }> {
  const response = await request(app.getHttpServer())
    .get(`/orders/book?instrument=${instrument}`)
    .set('authorization', `Bearer ${user.token}`)
    .expect(200);
  return response.body;
}

export async function eventually(assertion: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export const range = (n: number) => Array.from({ length: n }, (_, i) => i);
