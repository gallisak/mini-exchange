import { afterEach, describe, expect, it, vi } from 'vitest';
import { refusePlaceholderSecrets } from './secrets';

describe('secrets of the frontend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuse the placeholder from .env.example in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_PROXY_KEY', 'change-me-proxy');

    expect(() => refusePlaceholderSecrets()).toThrow('FRONTEND_PROXY_KEY');
  });

  it('accept a generated key in production and anything outside it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_PROXY_KEY', 'a1b2c3');
    expect(() => refusePlaceholderSecrets()).not.toThrow();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FRONTEND_PROXY_KEY', 'change-me-proxy');
    expect(() => refusePlaceholderSecrets()).not.toThrow();
  });
});
