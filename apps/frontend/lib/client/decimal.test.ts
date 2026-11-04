import { describe, expect, it } from 'vitest';
import { subtractDecimals } from './decimal';

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
