import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('./next.config.js');

describe('security headers of every page', () => {
  it('forbid other sites to frame the app and limit where scripts and connections may go', async () => {
    const rules: { source: string; headers: { key: string; value: string }[] }[] = await config.headers();
    const all = rules.find((rule) => rule.source === '/:path*');
    const header = (key: string) => all?.headers.find((entry) => entry.key.toLowerCase() === key)?.value;

    expect(header('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(header('content-security-policy')).toContain("object-src 'none'");
    expect(header('content-security-policy')).toMatch(/connect-src 'self' ws:\/\/localhost:3001/);
    expect(header('x-frame-options')).toBe('DENY');
    expect(header('x-content-type-options')).toBe('nosniff');
  });
});
