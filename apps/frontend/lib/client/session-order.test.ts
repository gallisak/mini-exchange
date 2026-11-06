import { describe, expect, it } from 'vitest';
import { answeredForCurrentSession } from './session-order';

describe('a refusal that arrives around a sign-in', () => {
  it('signs out only for a request sent with the cookies of the current sign-in', () => {
    expect(answeredForCurrentSession(100, 200)).toBe(false);
    expect(answeredForCurrentSession(200, 200)).toBe(true);
    expect(answeredForCurrentSession(300, 200)).toBe(true);
    expect(answeredForCurrentSession(undefined, 200)).toBe(true);
  });
});
