import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ResetRoles1793810000000 } from '../../src/database/migrations/1793810000000-ResetRoles';
import { createApp, resetState } from './harness';

describe('roles granted by the old ADMIN_EMAILS setting', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('are taken away, so only grant-admin decides who is an admin', async () => {
    const credentials = { email: 'squatter@example.com', password: 'password123' };
    await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(201);
    const dataSource = app.get(DataSource);
    await dataSource.query(`UPDATE users SET role = 'admin' WHERE email = 'squatter@example.com'`);
    const runner = dataSource.createQueryRunner();

    await new ResetRoles1793810000000().up(runner);
    await runner.release();

    const login = await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(200);
    const claims = JSON.parse(Buffer.from(login.body.accessToken.split('.')[1], 'base64url').toString());
    expect(claims.role).toBe('user');
  });
});
