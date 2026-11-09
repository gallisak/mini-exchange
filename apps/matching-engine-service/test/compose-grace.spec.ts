import { readFileSync } from 'fs';
import { resolve } from 'path';
import { STOP_WAIT_MS } from '../src/orders/engine/book-runner';

describe('the time compose gives an engine to stop', () => {
  it('is longer than the engine waits for a batch, so it still releases its leases before it is killed', () => {
    const compose = readFileSync(resolve(__dirname, '../../../docker-compose.yml'), 'utf8');
    const engine = compose.slice(compose.indexOf('  matching-engine-1:'), compose.indexOf('  matching-engine-2:'));
    const graceMs = Number(/stop_grace_period: (\d+)s/.exec(engine)?.[1]) * 1000;

    expect(graceMs).toBeGreaterThanOrEqual(STOP_WAIT_MS + 5_000);
  });
});
