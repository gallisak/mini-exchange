import { ChildProcess, spawn } from 'child_process';
import { once } from 'events';
import { resolve } from 'path';
import { eventually } from './harness';

describe('API documentation', () => {
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('publishes an OpenAPI document with every route', async () => {
    child = spawn(process.execPath, ['dist/main'], {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, PORT: '4421' },
      stdio: 'ignore',
    });

    const document = await eventually(async () => {
      const response = await fetch('http://localhost:4421/docs-json');
      expect(response.status).toBe(200);
    }, 20000).then(() => fetch('http://localhost:4421/docs-json').then((r) => r.json()));

    expect(Object.keys(document.paths).sort()).toEqual(
      ['/admin/reconciliation', '/health', '/metrics', '/ops/status', '/trades/settle', '/wallets/me'].sort(),
    );
    expect(document.components.schemas.SettleTradeDto.required).toEqual(
      expect.arrayContaining(['tradeId', 'buyerId', 'sellerId', 'price', 'quantity']),
    );
  });
});
