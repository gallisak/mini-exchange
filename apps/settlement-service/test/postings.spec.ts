import { LEDGER_SCALE, fromUnits, toUnits } from '../src/common/decimal';
import {
  SYSTEM_OWNER,
  isBalanced,
  notional,
  openingPostings,
  tradePostings,
} from '../src/ledger/postings';

const terms = {
  instrument: 'ABC',
  buyerId: 'buyer',
  sellerId: 'seller',
  price: '10.50',
  quantity: '2.5',
};

describe('ledger postings', () => {
  it('moves the notional to the seller and the asset to the buyer', () => {
    const postings = tradePostings(terms).map((posting) => ({
      ...posting,
      amount: fromUnits(posting.amount, LEDGER_SCALE, 2),
    }));

    expect(postings).toEqual([
      { ownerId: 'buyer', asset: 'USD', amount: '-26.25' },
      { ownerId: 'seller', asset: 'USD', amount: '26.25' },
      { ownerId: 'buyer', asset: 'ABC', amount: '2.50' },
      { ownerId: 'seller', asset: 'ABC', amount: '-2.50' },
    ]);
  });

  it('balances every asset of a trade to zero', () => {
    expect(isBalanced(tradePostings(terms))).toBe(true);
    expect(isBalanced(tradePostings({ ...terms, price: '0.01', quantity: '0.00000001' }))).toBe(true);
  });

  it('balances an opening against the system account', () => {
    const postings = openingPostings('owner', 'USD');

    expect(isBalanced(postings)).toBe(true);
    expect(postings.map((posting) => posting.ownerId)).toEqual(['owner', SYSTEM_OWNER]);
    expect(fromUnits(postings[0].amount, LEDGER_SCALE, 2)).toBe('100000.00');
  });

  it('detects postings that do not balance', () => {
    const [first, ...rest] = tradePostings(terms);

    expect(isBalanced(rest)).toBe(false);
    expect(isBalanced([{ ...first, amount: first.amount + 1n }, ...rest])).toBe(false);
  });

  it('computes the notional exactly at the smallest price and quantity', () => {
    expect(notional('0.01', '0.00000001')).toBe(1n);
    expect(fromUnits(notional('9999999999999999.99', '9999999999.99999999'), LEDGER_SCALE)).toBe(
      '99999999999999999800000000.0000000001',
    );
  });
});

describe('ledger amounts', () => {
  it('round-trips signed amounts at ledger scale', () => {
    expect(fromUnits(toUnits('-0.0000000001', LEDGER_SCALE), LEDGER_SCALE)).toBe('-0.0000000001');
    expect(toUnits('99979.0000000000', LEDGER_SCALE)).toBe(toUnits('99979', LEDGER_SCALE));
  });

  it('trims trailing zeros only down to the display scale', () => {
    expect(fromUnits(toUnits('99979', LEDGER_SCALE), LEDGER_SCALE, 2)).toBe('99979.00');
    expect(fromUnits(toUnits('0.123', LEDGER_SCALE), LEDGER_SCALE, 2)).toBe('0.123');
    expect(fromUnits(toUnits('1000', LEDGER_SCALE), LEDGER_SCALE, 8)).toBe('1000.00000000');
  });

  it('rejects more precision than the ledger keeps', () => {
    expect(() => toUnits('0.00000000001', LEDGER_SCALE)).toThrow();
  });
});
