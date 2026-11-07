import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { PostgresQueryRunner } from 'typeorm/driver/postgres/PostgresQueryRunner';
import { RefreshSession } from '../../src/auth/entities/refresh-session.entity';
import { LowercaseEmails1793781500000 } from '../../src/database/migrations/1793781500000-LowercaseEmails';
import { setAdmin } from '../../src/tools/grant-admin';
import { RedisService } from '../../src/redis/redis.service';
import { SessionRevocations } from '../../src/auth/session-revocations.service';
import { buildDataSourceOptions } from '../../src/database/data-source';
import { createApp, eventually, resetState } from './harness';

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

  it('answers 409, not 500, when the same email registers with different passwords at once', async () => {
    const email = `race-${randomUUID()}@example.com`;
    const statuses = await Promise.all(
      Array.from({ length: 5 }, (_, n) =>
        http().post('/auth/register').send({ email, password: `password-${n}` }),
      ),
    ).then((responses) => responses.map((response) => response.status).sort());

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  it('signs in a registration repeated with the same password, so one whose answer was lost is not refused', async () => {
    const email = `retry-${randomUUID()}@example.com`;
    const first = await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);

    const again = await http().post('/auth/register').send({ email, password: 'password123' }).expect(201);
    await http().post('/auth/register').send({ email, password: 'another-password' }).expect(409);

    expect(claims(again.body.accessToken).sub).toBe(claims(first.body.accessToken).sub);
  });

  it('gives every simultaneous registration with the same password the same account', async () => {
    const email = `same-${randomUUID()}@example.com`;
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => http().post('/auth/register').send({ email, password: 'password123' })),
    );

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(new Set(responses.map((response) => claims(response.body.accessToken).sub)).size).toBe(1);
  });

  it('does not take a refresh token for an access token even when the secrets were set the same by mistake', async () => {
    await app.close();
    const refreshSecret = process.env.JWT_REFRESH_SECRET;
    process.env.JWT_REFRESH_SECRET = process.env.JWT_ACCESS_SECRET;
    app = await createApp();
    try {
      const session = await signUp();

      await http().get('/orders').set('authorization', `Bearer ${session.refreshToken}`).expect(401);
      await http().get('/orders').set('authorization', `Bearer ${session.accessToken}`).expect(200);
    } finally {
      await app.close();
      process.env.JWT_REFRESH_SECRET = refreshSecret;
      app = await createApp();
    }
  });

  const sign = (payload: object, secret: string | undefined, options: object = { expiresIn: '5m' }) =>
    new JwtService().sign(payload, { secret, ...options });

  it('says what each token is for', async () => {
    const session = await signUp();
    const ticket = (await http().post('/auth/ws-ticket').set('authorization', `Bearer ${session.accessToken}`).expect(200)).body;

    expect(claims(session.accessToken).typ).toBe('access');
    expect(claims(session.refreshToken).typ).toBe('refresh');
    expect(claims(ticket.ticket).typ).toBe('ws');
  });

  it('refuses a token of another type as an access token, and takes one from before types existed', async () => {
    const session = await signUp();
    const { sub, sid, email } = claims(session.accessToken);
    const secret = process.env.JWT_ACCESS_SECRET;
    const asAccess = (token: string) => http().get('/orders').set('authorization', `Bearer ${token}`);

    await asAccess(sign({ sub, sid, email, typ: 'refresh' }, secret)).expect(401);
    await asAccess(sign({ sub, sid, email, typ: 'ws' }, secret)).expect(401);
    await asAccess(sign({ sub, sid, email, jti: randomUUID() }, secret)).expect(401);
    await asAccess(sign({ sub, sid, email }, secret)).expect(200);
  });

  it('refuses a token of another type as a refresh token, and takes one from before types existed', async () => {
    const session = await signUp();
    const { sub, jti, exp, iat } = claims(session.refreshToken);
    const secret = process.env.JWT_REFRESH_SECRET;

    await refresh(sign({ sub, jti, typ: 'access' }, secret)).expect(401);
    const issuedBefore = sign({ sub, jti, iat, exp }, secret, {});
    await app
      .get(DataSource)
      .getRepository(RefreshSession)
      .update({ id: jti as string }, { tokenHash: createHash('sha256').update(issuedBefore).digest('hex') });
    await refresh(issuedBefore).expect(200);
  });

  it('ends the session of a refresh token a browser forgot, along with its access token', async () => {
    const session = await signUp();

    await http().post('/auth/end-session').send({ refreshToken: session.refreshToken }).expect(204);

    await refresh(session.refreshToken).expect(401);
    await http().get('/orders').set('authorization', `Bearer ${session.accessToken}`).expect(401);
  });

  it('ends only the session of that refresh token, and refuses a token that is not one', async () => {
    const email = `two-${randomUUID()}@example.com`;
    const forgotten = (await http().post('/auth/register').send({ email, password: 'password123' }).expect(201)).body;
    const kept = await login(email);

    await http().post('/auth/end-session').send({ refreshToken: kept.accessToken }).expect(401);
    await http().post('/auth/end-session').send({ refreshToken: forgotten.refreshToken }).expect(204);

    await refresh(kept.refreshToken).expect(200);
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
      .send({ email: 'TRADER@example.com', password: 'another-password' })
      .expect(409);
  });

  it('gives the same rotation again to the caller that lost its answer', async () => {
    const session = await signUp();
    const attempt = randomUUID();
    await refresh(session.refreshToken, attempt).expect(200);

    const retried = await refresh(session.refreshToken, attempt).expect(200);

    const next = await refresh(retried.body.refreshToken).expect(200);
    await refresh(session.refreshToken, attempt).expect(409);
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
      .send({ email: 'legacy@example.com', password: 'another-password' })
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

  function failNextRedisTransaction() {
    const client = app.get(RedisService).client;
    const multi = client.multi.bind(client) as (...args: unknown[]) => ReturnType<typeof client.multi>;
    jest.spyOn(client, 'multi').mockImplementationOnce(((...args: unknown[]) => {
      const batch = multi(...args);
      batch.exec = (async () => {
        throw new Error('Connection is closed.');
      }) as never;
      return batch;
    }) as never);
  }

  it('ends the access of a family caught reusing a token even when Redis failed at that moment', async () => {
    const session = await signUp();
    const rotated = (await refresh(session.refreshToken).expect(200)).body;
    failNextRedisTransaction();

    await refresh(session.refreshToken).expect(401);

    await eventually(async () => {
      await http().get('/orders').set('authorization', `Bearer ${rotated.accessToken}`).expect(401);
    }, 10_000);
  });

  it('does not report a sign-out as done while Redis refuses the note that ends its access token, and finishes it on a retry', async () => {
    const session = await signUp();
    failNextRedisTransaction();

    const refused = await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect(503);
    expect(refused.body.code).toBe('SESSION_ENDED');
    await refresh(session.refreshToken).expect(401);
    await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect((response) => {
      expect([204, 401]).toContain(response.status);
    });

    await eventually(async () => {
      await http().get('/orders').set('authorization', `Bearer ${session.accessToken}`).expect(401);
    }, 10_000);
  });

  it('forgets refresh sessions whose tokens expired long ago and keeps the rest', async () => {
    const session = await signUp();
    const repository = app.get(DataSource).getRepository(RefreshSession);
    const old = randomUUID();
    const [kept] = await repository.find();
    await repository.insert({
      id: old,
      userId: kept.userId,
      familyId: randomUUID(),
      tokenHash: 'expired',
      createdAt: new Date(Date.now() - 9 * 24 * 3_600_000),
    });

    await app.get(SessionRevocations).cleanUp();

    expect((await repository.find()).map((row) => row.id)).toEqual([kept.id]);
    await refresh(session.refreshToken).expect(200);
  });

  it('gives up on a refresh that waits for the session lock instead of outlasting the gateway', async () => {
    const session = await signUp();
    const [{ userId }] = await app.get(DataSource).getRepository(RefreshSession).find();
    const holder = app.get(DataSource).createQueryRunner();
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [`refresh-sessions:${userId}`]);
    try {
      const started = Date.now();
      const response = await refresh(session.refreshToken);

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [`refresh-sessions:${userId}`]);
      await holder.release();
    }
    await refresh(session.refreshToken).expect(200);
  });

  const delayNewSessions = (ms: number) => {
    const insert = EntityManager.prototype.insert;
    return jest.spyOn(EntityManager.prototype, 'insert').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<typeof insert>
    ) {
      await sleep(ms);
      return insert.apply(this, args);
    } as never);
  };

  it('rolls a rotation back once it was answered 503, so a retry without an attempt is not taken for reuse', async () => {
    const session = await signUp();
    const repository = app.get(DataSource).getRepository(RefreshSession);
    const slow = delayNewSessions(5_500);
    try {
      await refresh(session.refreshToken).expect(503);
      await eventually(async () => expect(slow.mock.results[0]).toBeDefined());
      await sleep(1_000);
    } finally {
      slow.mockRestore();
    }

    const [row, ...others] = await repository.find();
    expect(others).toEqual([]);
    expect(row.usedAt).toBeNull();
    await refresh(session.refreshToken).expect(200);
  });

  it('does not answer 503 while the commit of a rotation is under way, since the rotation may land', async () => {
    const session = await signUp();
    const slow = delayNewSessions(4_800);
    const commit = PostgresQueryRunner.prototype.commitTransaction;
    const slowCommit = jest
      .spyOn(PostgresQueryRunner.prototype, 'commitTransaction')
      .mockImplementation(async function (this: PostgresQueryRunner) {
        await sleep(500);
        return commit.apply(this);
      });
    try {
      const rotated = await refresh(session.refreshToken).expect(200);

      expect(rotated.body.refreshToken).toEqual(expect.any(String));
    } finally {
      slow.mockRestore();
      slowCommit.mockRestore();
    }
  });

  const delayRecords = (ms: number) => {
    const revocations = app.get(SessionRevocations);
    const record = revocations.record.bind(revocations);
    return jest.spyOn(revocations, 'record').mockImplementation(async (manager, families) => {
      await sleep(ms);
      return record(manager, families);
    });
  };

  it('leaves a session as it was when a sign-out was answered 503, so 503 never hides a change', async () => {
    const session = await signUp();
    const slow = delayRecords(5_500);
    try {
      await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect(503);
      await sleep(1_000);
    } finally {
      slow.mockRestore();
    }

    await refresh(session.refreshToken).expect(200);
  });

  it('ends a family caught reusing a token even when the client was answered 503 before the commit', async () => {
    const session = await signUp();
    const rotated = (await refresh(session.refreshToken).expect(200)).body;
    const slow = delayRecords(5_500);
    try {
      await refresh(session.refreshToken).expect(503);
      await eventually(async () => {
        await http().get('/orders').set('authorization', `Bearer ${rotated.accessToken}`).expect(401);
      }, 5_000);
    } finally {
      slow.mockRestore();
    }

    const rows = await app.get(DataSource).getRepository(RefreshSession).find();
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    await refresh(rotated.refreshToken).expect(401);
  });

  it('answers 503 within the gateway timeout when a sign-out waits for the session lock', async () => {
    const session = await signUp();
    const [{ userId }] = await app.get(DataSource).getRepository(RefreshSession).find();
    const holder = app.get(DataSource).createQueryRunner();
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [`refresh-sessions:${userId}`]);
    try {
      const started = Date.now();
      await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect(503);
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [`refresh-sessions:${userId}`]);
      await holder.release();
    }
    await http().post('/auth/logout').set('authorization', `Bearer ${session.accessToken}`).expect(204);
  });

  it('cleans up expired refresh sessions as soon as an engine starts, not an hour later', async () => {
    const session = await signUp();
    const repository = app.get(DataSource).getRepository(RefreshSession);
    const [kept] = await repository.find();
    const old = randomUUID();
    await repository.insert({
      id: old,
      userId: kept.userId,
      familyId: randomUUID(),
      tokenHash: 'expired',
      createdAt: new Date(Date.now() - 9 * 24 * 3_600_000),
    });
    await app.close();

    app = await createApp();
    const restarted = app.get(DataSource).getRepository(RefreshSession);

    await eventually(async () => {
      expect((await restarted.find()).map((row) => row.id)).toEqual([kept.id]);
    });
    await refresh(session.refreshToken).expect(200);
  });

  it('keeps the connection of a cleanup until a cancel sent for it is through, so the cancel cannot hit another request', async () => {
    await app.close();
    const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    const familyId = randomUUID();
    await dataSource.query(
      `INSERT INTO "session_revocations" ("familyId", "revokedAt") VALUES ($1, now() - interval '2 days')`,
      [familyId],
    );
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(`SELECT 1 FROM "session_revocations" WHERE "familyId" = $1 FOR UPDATE`, [familyId]);
    let cancelSeen = () => undefined as void;
    const cancelAsked = new Promise<void>((resolve) => (cancelSeen = resolve));
    let letCancelThrough = () => undefined as void;
    const cancelHeld = new Promise<void>((resolve) => (letCancelThrough = resolve));
    try {
      app = await createApp();
      const engine = app.get(DataSource);
      const engineQuery = engine.query.bind(engine);
      const slowCancel = jest.spyOn(engine, 'query').mockImplementation((async (sql: string, parameters?: unknown[]) => {
        if (sql.includes('pg_cancel_backend')) {
          cancelSeen();
          await cancelHeld;
        }
        return engineQuery(sql, parameters);
      }) as never);
      const release = jest.spyOn(PostgresQueryRunner.prototype, 'release');
      let cleanupBackend = 0;
      await eventually(async () => {
        const rows: { pid: number }[] = await dataSource.query(
          `SELECT "pid" FROM pg_stat_activity
            WHERE "query" LIKE 'DELETE FROM "session_revocations"%' AND "wait_event_type" = 'Lock'`,
        );
        expect(rows).toHaveLength(1);
        cleanupBackend = rows[0].pid;
      });
      const cleanupReleased = () =>
        release.mock.contexts.some(
          (runner) =>
            (runner as unknown as { databaseConnection?: { processID: number } }).databaseConnection?.processID ===
            cleanupBackend,
        );

      const closing = app.close();
      await cancelAsked;
      await holder.rollbackTransaction();
      await eventually(async () => {
        const [{ running }] = await dataSource.query(
          `SELECT COUNT(*)::int AS "running" FROM pg_stat_activity
            WHERE "query" LIKE 'DELETE FROM%' AND "state" = 'active'`,
        );
        expect(running).toBe(0);
      });
      await sleep(200);
      expect(cleanupReleased()).toBe(false);

      letCancelThrough();
      await closing;
      expect(cleanupReleased()).toBe(true);
      slowCancel.mockRestore();
      release.mockRestore();
    } finally {
      letCancelThrough();
      if (holder.isTransactionActive) await holder.rollbackTransaction();
      await holder.release();
      await dataSource.destroy();
      app = await createApp();
    }
  });

  it('stops at once while a cleanup is waiting on the database', async () => {
    await app.close();
    const dataSource = await new DataSource(buildDataSourceOptions()).initialize();
    const familyId = randomUUID();
    await dataSource.query(
      `INSERT INTO "session_revocations" ("familyId", "revokedAt") VALUES ($1, now() - interval '2 days')`,
      [familyId],
    );
    const holder = dataSource.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    await holder.query(`SELECT 1 FROM "session_revocations" WHERE "familyId" = $1 FOR UPDATE`, [familyId]);
    try {
      app = await createApp();
      await eventually(async () => {
        const [{ waiting }] = await dataSource.query(
          `SELECT COUNT(*)::int AS "waiting" FROM pg_stat_activity
            WHERE "query" LIKE 'DELETE FROM "session_revocations"%' AND "wait_event_type" = 'Lock'`,
        );
        expect(waiting).toBe(1);
      });

      const started = Date.now();
      await app.close();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await holder.rollbackTransaction();
      await holder.release();
      await dataSource.destroy();
      app = await createApp();
    }
  });
});
