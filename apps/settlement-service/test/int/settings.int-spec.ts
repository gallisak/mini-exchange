import { spawn } from 'child_process';
import { once } from 'events';
import { resolve } from 'path';

describe('settings of a starting settlement service', () => {
  it('refuses to start in production with a placeholder secret from the example configuration', async () => {
    const child = spawn(process.execPath, ['dist/main'], {
      cwd: resolve(__dirname, '../..'),
      env: {
        ...process.env,
        PORT: '0',
        NODE_ENV: 'production',
        CONSUMER_ENABLED: 'false',
        ENGINE_INTERNAL_KEY: 'change-me-engine',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);

    const [code] = await once(child, 'exit');
    clearTimeout(timer);

    expect(code).not.toBe(0);
    expect(output).toContain('ENGINE_INTERNAL_KEY');
  });
});
