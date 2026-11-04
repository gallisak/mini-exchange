import { ChildProcess, spawn } from 'child_process';
import { once } from 'events';
import { resolve } from 'path';
import { eventually, publishTrade, redisClient, resetState, trade } from './harness';

describe('trace ids through settlement', () => {
  let child: ChildProcess | undefined;

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
  });

  it('settles a trade event under the trace id the engine gave it', async () => {
    let output = '';
    child = spawn(process.execPath, ['dist/main'], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, PORT: '4411' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    await eventually(async () => expect(output).toContain('Listening on 4411'), 20000);
    const redis = redisClient();
    const executed = trade({ traceId: 'trace-buy-1' });

    await publishTrade(redis, executed);
    await redis.quit();

    await eventually(async () => {
      const lines = output
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
      expect(lines).toContainEqual(
        expect.objectContaining({
          service: 'settlement-service',
          level: 'info',
          traceId: 'trace-buy-1',
          message: expect.stringMatching(new RegExp(`^Trade ${executed.tradeId} settled from trades:ABC `)),
        }),
      );
    }, 10000);
  });
});
