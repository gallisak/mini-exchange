import { Request } from 'express';
import { clientAddress, proxyHeaderFor } from '../src/rate-limit/rate-limit.guard';

const from = (headers: Record<string, string>) =>
  ({ ip: '10.0.0.5', header: (name: string) => headers[name] }) as unknown as Request;

describe('the address the frontend vouches for', () => {
  const key = process.env.FRONTEND_PROXY_KEY;

  beforeEach(() => {
    process.env.FRONTEND_PROXY_KEY = 'proxy-key';
  });

  afterEach(() => {
    if (key === undefined) delete process.env.FRONTEND_PROXY_KEY;
    else process.env.FRONTEND_PROXY_KEY = key;
  });

  it('is the one the frontend derives from the shared key, the same way the frontend does', () => {
    expect(proxyHeaderFor('proxy-key')).toBe('45b3e07d034673b9e8bfa1e6e415e26a669844bdce1b7493ebe33c82d094cc76');
    expect(clientAddress(from({ 'x-proxy-key': proxyHeaderFor('proxy-key'), 'x-client-ip': '203.0.113.7' }))).toBe(
      'client:203.0.113.7',
    );
  });

  it('is not taken with the shared key itself, which also signs the cookies of the frontend', () => {
    expect(clientAddress(from({ 'x-proxy-key': 'proxy-key', 'x-client-ip': '203.0.113.7' }))).toBe('10.0.0.5');
  });
});
