import { afterEach, describe, expect, it, vi } from 'vitest';
import { refuseUnsafeSecrets, warnAboutPlainCookies } from './secrets';

describe('secrets of the frontend', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuse the placeholder from .env.example in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_PROXY_KEY', 'change-me-proxy');

    expect(() => refuseUnsafeSecrets()).toThrow('FRONTEND_PROXY_KEY');
  });

  it('must include a key in production, or every process signs with its own', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_PROXY_KEY', '');

    expect(() => refuseUnsafeSecrets()).toThrow('FRONTEND_PROXY_KEY must be set');
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => refuseUnsafeSecrets()).not.toThrow();
  });

  it('warn in production when session cookies can be planted from a neighbouring subdomain', () => {
    const warn = vi.fn();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', 'false');
    warnAboutPlainCookies(warn);
    expect(warn).toHaveBeenCalledOnce();

    vi.stubEnv('COOKIE_SECURE', 'true');
    warnAboutPlainCookies(warn);
    vi.stubEnv('COOKIE_SECURE', 'false');
    vi.stubEnv('NODE_ENV', 'development');
    warnAboutPlainCookies(warn);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('accept a generated key in production and anything outside it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_PROXY_KEY', 'a1b2c3');
    expect(() => refuseUnsafeSecrets()).not.toThrow();
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FRONTEND_PROXY_KEY', 'change-me-proxy');
    expect(() => refuseUnsafeSecrets()).not.toThrow();
  });
});
