import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { RefreshSession } from '../../src/auth/entities/refresh-session.entity';
import { LowercaseEmails1793781500000 } from '../../src/database/migrations/1793781500000-LowercaseEmails';
import { setAdmin } from '../../src/tools/grant-admin';
import { createApp, resetState } from './harness';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const refresh = (refreshToken: string, attempt?: string) =>
    http().post('/auth/refresh').send({ refreshToken, ...(attempt ? { attempt } : {}) });
  const login = async (email: string, password = 'password123') =>
    (await http().post('/auth/login').send({ email, password }).expect(200)).body;

  it('answers 409, not 500, when the same email registers twice at once', async () => {
    const email = `race-${randomUUID()}@example.com`;
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () =>
        http().post('/auth/register').send({ email, password: 'password123' }),
      ),
    ).then((responses) => responses.map((response) => response.status).sort());

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

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

  it('keeps a user signed in on every device they signed in on', async () => {
    const email = `devices-${randomUUID()}@example.com`;
    const laptop = await signUp(email);
    const phone = (
      await http().post('/auth/login').send({ email, password: 'password123' }).expect(200)
    ).body;

    const laptopRefreshed = await refresh(laptop.refreshToken).expect(200);
    const phoneRefreshed = await refresh(phone.refreshToken).expect(200);

    await refresh(laptopRefreshed.body.refreshToken).expect(200);
    await refresh(phoneRefreshed.body.refreshToken).expect(200);
  });

  it('ends only the session whose refresh token was used twice', async () => {
    const email = `reuse-${randomUUID()}@example.com`;
    const stolen = await signUp(email);
    const other = (
      await http().post('/auth/login').send({ email, password: 'password123' }).expect(200)
    ).body;
    const rotated = await refresh(stolen.refreshToken).expect(200);

    await refresh(stolen.refreshToken).expect(401);

    await refresh(rotated.body.refreshToken).expect(401);
    await refresh(other.refreshToken).expect(200);
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

  it('does not make whoever registers an email from the configuration an admin', async () => {
    const squatter = await signUp('OPS@example.com');

    expect(claims(squatter.accessToken).role).toBe('user');
  });

  it('signs tokens with the role stored for the account, on sign-in and on refresh', async () => {
    const session = await signUp('promoted@example.com');
    const dataSource = app.get(DataSource);
    const login = async () =>
      (
        await http()
          .post('/auth/login')
          .send({ email: 'promoted@example.com', password: 'password123' })
          .expect(200)
      ).body;

    await dataSource.query(`UPDATE users SET role = 'admin' WHERE email = 'promoted@example.com'`);
    const promoted = await login();
    const refreshed = (await refresh(promoted.refreshToken).expect(200)).body;
    await dataSource.query(`UPDATE users SET role = 'user' WHERE email = 'promoted@example.com'`);
    const demoted = await login();

    expect(claims(session.accessToken).role).toBe('user');
    expect(claims(promoted.accessToken).role).toBe('admin');
    expect(claims(refreshed.accessToken).role).toBe('admin');
    expect(claims(demoted.accessToken).role).toBe('user');
  });

  it('grants and takes away the admin role through the operator tool', async () => {
    await signUp('operator@example.com');
    const dataSource = app.get(DataSource);
    const role = async () =>
      claims(
        (
          await http()
            .post('/auth/login')
            .send({ email: 'operator@example.com', password: 'password123' })
            .expect(200)
        ).body.accessToken,
      ).role;

    expect(await setAdmin(dataSource, ' Operator@Example.com ', true)).toBe(true);
    expect(await role()).toBe('admin');
    expect(await setAdmin(dataSource, 'operator@example.com', false)).toBe(true);
    expect(await role()).toBe('user');
    expect(await setAdmin(dataSource, 'nobody@example.com', true)).toBe(false);
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

  it('gives the same rotation again to the caller that lost its answer', async () => {
    const session = await signUp();
    const attempt = randomUUID();
    await refresh(session.refreshToken, attempt).expect(200);

    const retried = await refresh(session.refreshToken, attempt).expect(200);

    const next = await refresh(retried.body.refreshToken).expect(200);
    await refresh(session.refreshToken, attempt).expect(401);
    await refresh(next.body.refreshToken).expect(200);
  });

  it('still ends the session when a used refresh token comes back without the attempt that used it', async () => {
    const session = await signUp();
    const rotated = await refresh(session.refreshToken, randomUUID()).expect(200);

    await refresh(session.refreshToken, randomUUID()).expect(401);

    await refresh(rotated.body.refreshToken).expect(401);
  });

  it('signs out only the device that logs out', async () => {
    const email = `logout-${randomUUID()}@example.com`;
    const laptop = await signUp(email);
    const phone = await login(email);

    await http().post('/auth/logout').set('authorization', `Bearer ${laptop.accessToken}`).expect(204);

    await refresh(laptop.refreshToken).expect(401);
    await refresh(phone.refreshToken).expect(200);
  });

  it('stops honouring the admin role as soon as the operator tool takes it away', async () => {
    await signUp('chief@example.com');
    const dataSource = app.get(DataSource);
    await setAdmin(dataSource, 'chief@example.com', true);
    const admin = await login('chief@example.com');
    const status = () =>
      http().get('/ops/status').set('authorization', `Bearer ${admin.accessToken}`);
    await status().expect(200);

    await setAdmin(dataSource, 'chief@example.com', false);

    await status().expect(403);
  });

  it('signs in an account whose email differs from another one only in case', async () => {
    const dataSource = app.get(DataSource);
    const first = await signUp('clash-a@example.com');
    const second = (
      await http()
        .post('/auth/register')
        .send({ email: 'clash-b@example.com', password: 'another-password' })
        .expect(201)
    ).body;
    await dataSource.query(`UPDATE users SET email = 'Clash@Example.com' WHERE email = 'clash-a@example.com'`);
    await dataSource.query(`UPDATE users SET email = 'clash@example.com' WHERE email = 'clash-b@example.com'`);

    const firstAgain = await login('Clash@Example.com');
    const secondAgain = await login('clash@example.com', 'another-password');

    expect(claims(firstAgain.accessToken).sub).toBe(claims(first.accessToken).sub);
    expect(claims(secondAgain.accessToken).sub).toBe(claims(second.accessToken).sub);
    await http()
      .post('/auth/login')
      .send({ email: 'clash@example.com', password: 'wrong-password' })
      .expect(401);
  });

  it('refuses to register an email that an older account has in another case', async () => {
    await signUp('legacy@example.com');
    await app
      .get(DataSource)
      .query(`UPDATE users SET email = 'Legacy@Example.com' WHERE email = 'legacy@example.com'`);

    await http()
      .post('/auth/register')
      .send({ email: 'legacy@example.com', password: 'password123' })
      .expect(409);
  });

  it('grants the admin role to the account with exactly that email when several differ only in case', async () => {
    const dataSource = app.get(DataSource);
    await signUp('boss-a@example.com');
    await signUp('boss-b@example.com');
    await dataSource.query(`UPDATE users SET email = 'Boss@Example.com' WHERE email = 'boss-a@example.com'`);
    await dataSource.query(`UPDATE users SET email = 'BOSS@example.com' WHERE email = 'boss-b@example.com'`);

    expect(await setAdmin(dataSource, 'Boss@Example.com', true)).toBe(true);

    const roles: { email: string; role: string }[] = await dataSource.query(
      `SELECT email, role FROM users WHERE lower(email) = 'boss@example.com'`,
    );
    expect(roles.sort((a, b) => (a.email < b.email ? -1 : 1))).toEqual([
      { email: 'BOSS@example.com', role: 'user' },
      { email: 'Boss@Example.com', role: 'admin' },
    ]);
    await expect(setAdmin(dataSource, 'boss@example.com', true)).rejects.toThrow(/more than one/);
  });

  it('tells another service whether an account is an admin, given the internal key', async () => {
    const admin = await signUp('lookup@example.com');
    await setAdmin(app.get(DataSource), 'lookup@example.com', true);
    const user = await signUp();
    const lookup = (token: string) =>
      http()
        .get(`/auth/admins/${claims(token).sub}`)
        .set('x-internal-key', process.env.ENGINE_INTERNAL_KEY as string);

    expect((await lookup(admin.accessToken).expect(200)).body).toEqual({ admin: true });
    expect((await lookup(user.accessToken).expect(200)).body).toEqual({ admin: false });
    await http().get(`/auth/admins/${claims(user.accessToken).sub}`).expect(401);
  });

  it('gives a rotation made before the tokens became reproducible to the caller that retries it', async () => {
    const session = await signUp();
    const attempt = randomUUID();
    const rotated = await refresh(session.refreshToken, attempt).expect(200);
    await app
      .get(DataSource)
      .query(`UPDATE refresh_sessions SET "createdAt" = "createdAt" + interval '1.5 second' WHERE id = $1`, [
        claims(rotated.body.refreshToken).jti,
      ]);

    const first = await refresh(session.refreshToken, attempt).expect(200);
    const second = await refresh(session.refreshToken, attempt).expect(200);

    expect(second.body.refreshToken).toBe(first.body.refreshToken);
    await refresh(second.body.refreshToken).expect(200);
  });

  it('keeps the pair a retried rotation gave out when the original request arrives late', async () => {
    const session = await signUp();
    const attempt = randomUUID();
    await refresh(session.refreshToken, attempt).expect(200);
    await sleep(1100);
    const retried = await refresh(session.refreshToken, attempt).expect(200);
    await sleep(1100);

    await refresh(session.refreshToken, attempt).expect(200);

    await refresh(retried.body.refreshToken).expect(200);
  });

  it('issues a short-lived ticket for the real-time connection that the API does not accept', async () => {
    const session = await signUp();

    const response = await http()
      .post('/auth/ws-ticket')
      .set('authorization', `Bearer ${session.accessToken}`)
      .expect(200);

    const ticket = claims(response.body.ticket);
    expect(ticket.sub).toBe(claims(session.accessToken).sub);
    expect((ticket.exp as number) - (ticket.iat as number)).toBeLessThanOrEqual(60);
    expect(ticket.until).toBe(claims(session.accessToken).exp);
    await http().get('/orders').set('authorization', `Bearer ${response.body.ticket}`).expect(401);
    await http().post('/auth/ws-ticket').expect(401);
  });

  it('ends a session for good even while one of its rotations is being saved', async () => {
    const session = await signUp();
    const insert = EntityManager.prototype.insert;
    let saved!: () => void;
    const rotationSaved = new Promise<void>((resolve) => (saved = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['insert']>
    ) {
      const result = await insert.apply(this, args);
      if (args[0] === RefreshSession) {
        saved();
        await gate;
      }
      return result;
    });

    const rotating = refresh(session.refreshToken).then((response) => response);
    await rotationSaved;
    spy.mockRestore();
    const loggingOut = http()
      .post('/auth/logout')
      .set('authorization', `Bearer ${session.accessToken}`)
      .then((response) => response);
    await sleep(300);
    release();
    const [rotated, loggedOut] = await Promise.all([rotating, loggingOut]);

    expect(rotated.status).toBe(200);
    expect(loggedOut.status).toBe(204);
    await refresh(rotated.body.refreshToken).expect(401);
  });

  it('stops accepting the access token of a session that logged out, and only of that session', async () => {
    const email = `revoked-${randomUUID()}@example.com`;
    const laptop = await signUp(email);
    const phone = await login(email);

    await http().post('/auth/logout').set('authorization', `Bearer ${laptop.accessToken}`).expect(204);

    await http().get('/orders').set('authorization', `Bearer ${laptop.accessToken}`).expect(401);
    await http().post('/auth/ws-ticket').set('authorization', `Bearer ${laptop.accessToken}`).expect(401);
    await http().get('/orders').set('authorization', `Bearer ${phone.accessToken}`).expect(200);
  });

  it('does not count silent refreshes and logouts against the sign-in limit', async () => {
    const limit = process.env.AUTH_RATE_LIMIT;
    process.env.AUTH_RATE_LIMIT = '2';
    try {
      const email = `limited-${randomUUID()}@example.com`;
      let session = await signUp(email);
      for (let i = 0; i < 3; i += 1) {
        session = (await refresh(session.refreshToken).expect(200)).body;
      }
      await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect(204);

      await http().post('/auth/login').send({ email, password: 'password123' }).expect(200);
      await http().post('/auth/login').send({ email, password: 'password123' }).expect(429);
    } finally {
      process.env.AUTH_RATE_LIMIT = limit;
    }
  });
});
