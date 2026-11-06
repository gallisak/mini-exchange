import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const call = (method: string, headers: Record<string, string>, path = '/api/auth/logout') =>
  middleware(new NextRequest(`http://exchange.test${path}`, { method, headers: { host: 'exchange.test', ...headers } }));

const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';

describe('requests another site makes the browser send', () => {
  it('cannot sign a user out or change anything through the API', () => {
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example' },
      { origin: 'http://exchange.test.evil.example' },
      { origin: 'null' },
    ]) {
      for (const [method, path] of [
        ['POST', '/api/auth/logout'],
        ['POST', '/api/orders'],
        ['DELETE', '/api/orders/1'],
      ]) {
        const response = call(method, headers, path);
        expect(response.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
  });

  it('leave the pages of the app and the API reads alone', () => {
    expect(passed(call('GET', { 'sec-fetch-site': 'cross-site' }, '/orders'))).toBe(true);
    expect(passed(call('GET', { 'sec-fetch-site': 'cross-site' }, '/api/market/book'))).toBe(true);
  });

  it('are told apart from the requests of the app itself', () => {
    expect(passed(call('POST', { 'sec-fetch-site': 'same-origin', origin: 'http://exchange.test' }))).toBe(true);
    expect(passed(call('POST', { origin: 'http://exchange.test' }))).toBe(true);
    expect(passed(call('POST', {}))).toBe(true);
  });
});
