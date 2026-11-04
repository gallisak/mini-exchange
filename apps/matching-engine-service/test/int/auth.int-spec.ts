import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { LowercaseEmails1793781500000 } from '../../src/database/migrations/1793781500000-LowercaseEmails';
import { createApp, resetState } from './harness';

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

describe('authentication sessions', () => {
  let app: INestApplication;
  const adminEmails = process.env.ADMIN_EMAILS;

  beforeEach(async () => {
    await resetState();
    process.env.ADMIN_EMAILS = 'boss@example.com, Ops@Example.com';
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
    process.env.ADMIN_EMAILS = adminEmails;
  });

  const http = () => request(app.getHttpServer());
  const signUp = async (email = `user-${randomUUID()}@example.com`) =>
    (await http().post('/auth/register').send({ email, password: 'password123' }).expect(201)).body;
  const refresh = (refreshToken: string) => http().post('/auth/refresh').send({ refreshToken });

  it('trades a refresh token for a new pair once', async () => {
    const session = await signUp();

    const rotated = await refresh(session.refreshToken).expect(200);
    const next = await refresh(rotated.body.refreshToken).expect(200);

    expect(rotated.body.refreshToken).not.toBe(session.refreshToken);
    expect(claims(rotated.body.accessToken).sub).toBe(claims(session.accessToken).sub);
    expect(next.body.accessToken).toEqual(expect.any(String));
  });

  it('ends the session when an already used refresh token comes back', async () => {
    const session = await signUp();
    const rotated = await refresh(session.refreshToken).expect(200);

    await refresh(session.refreshToken).expect(401);

    await refresh(rotated.body.refreshToken).expect(401);
  });

  it('lets only one of two simultaneous refreshes with the same token through', async () => {
    const session = await signUp();

    const statuses = (await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)])).map(
      (response) => response.status,
    );

    expect(statuses.sort()).toEqual([200, 401]);
  });

  it('does not accept an access token as a refresh token', async () => {
    const session = await signUp();

    await refresh(session.accessToken).expect(401);
  });

  it('revokes the refresh token on logout', async () => {
    const session = await signUp();

    await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect(204);

    await refresh(session.refreshToken).expect(401);
    await http().post('/auth/logout').expect(401);
  });

  it('gives the admin role only to configured emails', async () => {
    const admin = await signUp('OPS@example.com');
    const user = await signUp();

    expect(claims(admin.accessToken).role).toBe('admin');
    expect(claims(user.accessToken).role).toBe('user');
  });

  it('follows ADMIN_EMAILS on every sign-in, granting and taking away the role', async () => {
    await signUp('boss@example.com');
    const login = async () =>
      claims(
        (
          await http()
            .post('/auth/login')
            .send({ email: 'boss@example.com', password: 'password123' })
            .expect(200)
        ).body.accessToken,
      ).role;

    process.env.ADMIN_EMAILS = 'someone-else@example.com';
    expect(await login()).toBe('user');
    process.env.ADMIN_EMAILS = 'BOSS@example.com';
    expect(await login()).toBe('admin');
  });

  it('lowercases stored emails that would otherwise no longer sign in, unless that would clash', async () => {
    const dataSource = app.get(DataSource);
    await signUp('mixed@example.com');
    await signUp('taken@example.com');
    await dataSource.query(`UPDATE users SET email = 'Mixed@Example.com' WHERE email = 'mixed@example.com'`);
    await dataSource.query(
      `INSERT INTO users (email, "passwordHash") VALUES ('Taken@Example.com', 'x')`,
    );
    const runner = dataSource.createQueryRunner();

    await new LowercaseEmails1793781500000().up(runner);
    await runner.release();

    await http()
      .post('/auth/login')
      .send({ email: 'Mixed@Example.com', password: 'password123' })
      .expect(200);
    const emails = (await dataSource.query(`SELECT email FROM users ORDER BY email`)).map(
      (row: { email: string }) => row.email,
    );
    expect(emails).toEqual(['Taken@Example.com', 'mixed@example.com', 'taken@example.com']);
  });

  it('treats emails case-insensitively', async () => {
    await signUp('Trader@Example.com');

    await http()
      .post('/auth/login')
      .send({ email: 'trader@example.com', password: 'password123' })
      .expect(200);
    await http()
      .post('/auth/register')
      .send({ email: 'TRADER@example.com', password: 'password123' })
      .expect(409);
  });
});
