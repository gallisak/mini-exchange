import { spawn } from 'child_process';
import { once } from 'events';
import { resolve } from 'path';
import { InstrumentOwnershipService } from '../../src/orders/engine/instrument-ownership.service';
import { createApp, eventually, resetState } from './harness';

describe('numeric settings of a running engine', () => {
  const saved = { ...process.env };

  beforeEach(async () => {
    await resetState();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('still owns instruments with the book heartbeat switched off', async () => {
    process.env.BOOK_HEARTBEAT_MS = '0';
    const app = await createApp();
    try {
      await eventually(async () =>
        expect(app.get(InstrumentOwnershipService).ownedInstruments()).toContain('ABC'),
      );
    } finally {
      await app.close();
    }
  });

  it('refuses to start with a history limit that is not a number, instead of failing every request', async () => {
    const engine = spawn(process.execPath, ['dist/main'], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, PORT: '0', ORDER_HISTORY_LIMIT: 'all' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    engine.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    engine.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => engine.kill('SIGKILL'), 20_000);

    const [code] = await once(engine, 'exit');
    clearTimeout(timer);

    expect(code).not.toBe(0);
    expect(output).toContain('ORDER_HISTORY_LIMIT');
  });

  it('refuses to start in production with a placeholder secret from the example configuration', async () => {
    const engine = spawn(process.execPath, ['dist/main'], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, PORT: '0', NODE_ENV: 'production', JWT_REFRESH_SECRET: 'change-me-refresh' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    engine.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    engine.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => engine.kill('SIGKILL'), 20_000);

    const [code] = await once(engine, 'exit');
    clearTimeout(timer);

    expect(code).not.toBe(0);
    expect(output).toContain('JWT_REFRESH_SECRET');
  });
});
