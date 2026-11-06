import { describe, expect, it } from 'vitest';
import { latestRequest } from './latest';

describe('the latest of several overlapping requests', () => {
  it('is the only one whose answer may be shown, whatever order the answers come in', () => {
    const begin = latestRequest();
    const older = begin();
    const newer = begin();

    expect(newer()).toBe(true);
    expect(older()).toBe(false);
  });
});
