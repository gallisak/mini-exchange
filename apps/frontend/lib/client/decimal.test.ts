import { describe, expect, it } from 'vitest';
import { notionalAbove, subtractDecimals } from './decimal';

describe('the limit on what one order may be worth', () => {
  it('lets an order up to it through and stops one above it', () => {
    expect(notionalAbove('1000000.00', '1000000000')).toBe(false);
    expect(notionalAbove('1000000.01', '1000000000')).toBe(true);
    expect(notionalAbove('9999999999999999.99', '0.00000001')).toBe(false);
    expect(notionalAbove('9999999999999999.99', '9999999999')).toBe(true);
  });

  it('says nothing about a price or quantity that is not typed in yet or is not a number', () => {
    expect(notionalAbove('20.00', '')).toBe(false);
    expect(notionalAbove('', '3')).toBe(false);
    expect(notionalAbove('20.00', '1.')).toBe(false);
    expect(notionalAbove('abc', '3')).toBe(false);
  });
});

describe('decimal arithmetic for display', () => {
  it('subtracts exactly where floating point would not', () => {
    expect(subtractDecimals('0.3', '0.1')).toBe('0.2');
    expect(subtractDecimals('9999999999.99999999', '0.00000001')).toBe('9999999999.99999998');
    expect(subtractDecimals('9999999999999999.99', '9999999999999999.98')).toBe('0.01');
  });

  it('aligns different scales and keeps the sign', () => {
    expect(subtractDecimals('1.00000000', '0.5')).toBe('0.50000000');
    expect(subtractDecimals('100.00', '101.50')).toBe('-1.50');
  });
});
