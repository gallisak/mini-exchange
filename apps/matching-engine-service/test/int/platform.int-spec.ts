import { INestApplication } from '@nestjs/common';
import { spawn } from 'child_process';
import { once } from 'events';
import { resolve } from 'path';
import { AddressInfo } from 'net';
import { io } from 'socket.io-client';
import request from 'supertest';
import { EngineProcess, startEngine, stopEngine } from './engines';
import { createApp, range, register, resetState, submit } from './harness';

function withEnv(overrides: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('platform protections', () => {
  describe('rate limits', () => {
    let app: INestApplication;
    let restore: () => void;

    beforeEach(async () => {
      await resetState();
      restore = withEnv({
        ORDER_RATE_LIMIT: '10',
        ORDER_RATE_WINDOW_MS: '60000',
        AUTH_RATE_LIMIT: '5',
        AUTH_RATE_WINDOW_MS: '60000',
      });
      app = await createApp();
    });

    afterEach(async () => {
      await app.close();
      restore();
    });

    it('answers 429 once a user floods order submission and leaves other users alone', async () => {
      const [flooder, bystander] = [await register(app), await register(app)];

      const responses = await Promise.all(
        range(30).map(() => submit(app, flooder, { side: 'buy', price: '1.00', quantity: '1' })),
      );
      const other = await submit(app, bystander, { side: 'buy', price: '1.00', quantity: '1' });

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 202)).toHaveLength(10);
      expect(statuses.filter((status) => status === 429)).toHaveLength(20);
      expect(Number(responses.find((r) => r.status === 429)?.headers['retry-after'])).toBeGreaterThan(0);
      expect(other.status).toBe(202);
    });

    it('answers 429 to repeated login attempts from one address', async () => {
      const attempts = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        attempts.push(
          (
            await request(app.getHttpServer())
              .post('/auth/login')
              .send({ email: 'nobody@example.com', password: 'wrong-password' })
          ).status,
        );
      }

      expect(attempts).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    });
  });

  describe('WebSocket snapshots', () => {
    let app: INestApplication;
    let restore: () => void;

    beforeEach(async () => {
      await resetState();
      restore = withEnv({ WS_SNAPSHOT_LIMIT: '3', WS_SNAPSHOT_WINDOW_MS: '60000' });
      app = await createApp();
      await app.listen(0);
    });

    afterEach(async () => {
      await app.close();
      restore();
    });

    it('stops serving book snapshots to a socket that keeps asking for them', async () => {
      const port = (app.getHttpServer().address() as AddressInfo).port;
      const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
      const snapshots: unknown[] = [];
      const limited: { retryAfterMs: number }[] = [];
      socket.on('book_snapshot', (snapshot: unknown) => snapshots.push(snapshot));
      socket.on('rate_limited', (notice: { retryAfterMs: number }) => limited.push(notice));
      try {
        await new Promise((resolve) => socket.once('connected', resolve));
        for (let attempt = 0; attempt < 10; attempt += 1) socket.emit('subscribe', 'ABC');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        socket.disconnect();
      }

      expect(snapshots).toHaveLength(3);
      expect(limited).toHaveLength(7);
      expect(limited[0].retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('engine process', () => {
    const engines: EngineProcess[] = [];

    beforeEach(async () => {
      await resetState();
    });

    afterEach(async () => {
      await Promise.all(engines.splice(0).map((engine) => stopEngine(engine, 'SIGKILL')));
    });

    it('refuses to start without its token secrets', async () => {
      const env: Record<string, string | undefined> = { ...process.env, PORT: '4301' };
      delete env.JWT_ACCESS_SECRET;
      delete env.JWT_REFRESH_SECRET;
      const child = spawn(process.execPath, ['dist/main'], {
        cwd: resolve(__dirname, '../..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);

      const [code, signal] = await once(child, 'exit');
      clearTimeout(timer);

      expect(signal).toBeNull();
      expect(code).not.toBe(0);
      expect(output).toContain('JWT_ACCESS_SECRET');
    });

    it('answers cross-origin requests only for the configured origins', async () => {
      const engine = await startEngine('engine-cors', 4302, { CORS_ORIGINS: 'http://localhost:3000' });
      engines.push(engine);
      const allowOrigin = async (origin: string) =>
        (
          await fetch(`${engine.url}/orders/book?instrument=ABC`, { headers: { origin } })
        ).headers.get('access-control-allow-origin');

      expect(await allowOrigin('http://localhost:3000')).toBe('http://localhost:3000');
      expect(await allowOrigin('https://evil.example')).toBeNull();
    });
  });
});
