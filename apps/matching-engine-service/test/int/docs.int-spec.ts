import { EngineProcess, startEngine, stopEngine } from './engines';
import { resetState } from './harness';

describe('API documentation', () => {
  let engine: EngineProcess | undefined;

  beforeEach(async () => {
    await resetState();
  });

  afterEach(async () => {
    if (engine) await stopEngine(engine, 'SIGKILL');
  });

  it('publishes an OpenAPI document with every public route and the order body', async () => {
    engine = await startEngine('engine-docs', 4321);

    const response = await fetch(`${engine.url}/docs-json`);
    const document = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/auth/register',
        '/auth/login',
        '/auth/refresh',
        '/auth/logout',
        '/orders',
        '/orders/{id}',
        '/orders/book',
        '/trades',
        '/trades/summary',
        '/health',
        '/metrics',
        '/ops/status',
      ]),
    );
    expect(Object.keys(document.components.schemas.SubmitOrderDto.properties).sort()).toEqual([
      'instrument',
      'price',
      'quantity',
      'side',
    ]);
    expect((await fetch(`${engine.url}/docs`)).status).toBe(200);
  });
});
