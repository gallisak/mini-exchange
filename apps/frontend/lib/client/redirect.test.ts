import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('redirect after sign-in', () => {
  it('keeps a path inside the app', () => {
    expect(safeRedirect('/wallet')).toBe('/wallet');
    expect(safeRedirect('/orderbook?instrument=DEF')).toBe('/orderbook?instrument=DEF');
  });

  it('refuses anything that would leave the app', () => {
    for (const target of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      ' /wallet',
      '',
      null,
    ]) {
      expect(safeRedirect(target)).toBe('/orders');
    }
  });
});
