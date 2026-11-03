import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { balances, createApp, range, resetState, settle, trade } from './harness';

const OPENING = { USD: '100000.00', ABC: '1000.00000000', DEF: '1000.00000000', XYZ: '1000.00000000' };

describe('trade settlement', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetState();
    app = await createApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('opens a wallet with the starting balance', async () => {
    expect(await balances(app, randomUUID())).toEqual(OPENING);
  });

  it('moves money from the buyer to the seller and the asset back', async () => {
    const executed = trade({ price: '10.50', quantity: '2' });

    const response = await settle(app, executed);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tradeId: executed.tradeId, status: 'settled' });
    expect(await balances(app, executed.buyerId)).toEqual({
      ...OPENING,
      USD: '99979.00',
      ABC: '1002.00000000',
    });
    expect(await balances(app, executed.sellerId)).toEqual({
      ...OPENING,
      USD: '100021.00',
      ABC: '998.00000000',
    });
  });

  it('keeps every fraction of a cent of the notional', async () => {
    const executed = trade({ price: '0.01', quantity: '0.00000001' });

    await settle(app, executed).expect(200);

    expect((await balances(app, executed.buyerId)).USD).toBe('99999.9999999999');
    expect((await balances(app, executed.sellerId)).USD).toBe('100000.0000000001');
  });

  it('moves money once when the same trade is delivered again', async () => {
    const executed = trade();

    await settle(app, executed).expect(200);
    const again = await settle(app, executed);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ tradeId: executed.tradeId, status: 'duplicate' });
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
    expect((await balances(app, executed.sellerId)).USD).toBe('100021.00');
  });

  it('moves money once when the same trade arrives many times at once', async () => {
    const executed = trade();

    const responses = await Promise.all(range(10).map(() => settle(app, executed)));

    expect(responses.map((response) => response.status)).toEqual(range(10).map(() => 200));
    expect(responses.filter((response) => response.body.status === 'settled')).toHaveLength(1);
    expect((await balances(app, executed.buyerId)).USD).toBe('99979.00');
  });

  it('rejects a trade id reused with different details', async () => {
    const executed = trade();
    await settle(app, executed).expect(200);

    const changed = await settle(app, { ...executed, quantity: '3' });

    expect(changed.status).toBe(409);
    expect((await balances(app, executed.buyerId)).ABC).toBe('1002.00000000');
  });

  it('settles concurrent trades between the same two users in both directions', async () => {
    const [alice, bob] = [randomUUID(), randomUUID()];
    const trades = range(40).map((i) =>
      trade(
        i % 2 === 0
          ? { buyerId: alice, sellerId: bob, price: '10.00', quantity: '1' }
          : { buyerId: bob, sellerId: alice, price: '12.00', quantity: '3' },
      ),
    );

    const responses = await Promise.all(trades.map((executed) => settle(app, executed)));

    expect(responses.map((response) => response.status)).toEqual(trades.map(() => 200));
    expect(await balances(app, alice)).toEqual({
      ...OPENING,
      USD: '100520.00',
      ABC: '960.00000000',
    });
    expect(await balances(app, bob)).toEqual({
      ...OPENING,
      USD: '99480.00',
      ABC: '1040.00000000',
    });
  });

  it('refuses to settle without the internal key', async () => {
    const executed = trade();

    expect((await settle(app, executed, null)).status).toBe(401);
    expect((await settle(app, executed, 'wrong-key')).status).toBe(401);
    expect(await balances(app, executed.buyerId)).toEqual(OPENING);
  });

  it('keeps the settle endpoint closed when no internal key is configured', async () => {
    const configured = process.env.SETTLEMENT_INTERNAL_KEY;
    process.env.SETTLEMENT_INTERNAL_KEY = '';
    try {
      const executed = trade();

      expect((await settle(app, executed, '')).status).toBe(401);
      expect((await settle(app, executed, 'change-me-internal')).status).toBe(401);
      expect(await balances(app, executed.buyerId)).toEqual(OPENING);
    } finally {
      process.env.SETTLEMENT_INTERNAL_KEY = configured;
    }
  });

  it('rejects a trade that cannot be settled', async () => {
    const invalid = [
      trade({ instrument: 'NOPE' }),
      trade({ quantity: '0' }),
      trade({ price: '1.001' }),
      trade({ quantity: '-1' }),
      { ...trade(), buyerId: 'not-a-user' },
      (() => {
        const same = randomUUID();
        return trade({ buyerId: same, sellerId: same });
      })(),
    ];

    const statuses = await Promise.all(invalid.map(async (body) => (await settle(app, body)).status));

    expect(statuses).toEqual(invalid.map(() => 400));
  });

  it('shows a wallet only to its owner', async () => {
    await request(app.getHttpServer()).get('/wallets/me').expect(401);
    await request(app.getHttpServer())
      .get('/wallets/me')
      .set('authorization', 'Bearer not-a-token')
      .expect(401);
  });
});
