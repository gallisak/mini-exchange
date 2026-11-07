const PLACEHOLDER = /^change-me/i;

export function refuseUnsafeSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!process.env.FRONTEND_PROXY_KEY) {
    throw new Error('FRONTEND_PROXY_KEY must be set, or every restart signs everyone out and replicas disagree');
  }
  if (PLACEHOLDER.test(process.env.FRONTEND_PROXY_KEY)) {
    throw new Error('FRONTEND_PROXY_KEY still has the placeholder value from .env.example, set a real secret');
  }
}

export function warnAboutPlainCookies(warn: (message: string) => void = console.warn): void {
  if (process.env.NODE_ENV !== 'production' || process.env.COOKIE_SECURE === 'true') return;
  warn(
    'WARNING: COOKIE_SECURE is not true, so a neighbouring subdomain can plant session cookies. Set it on any deployment over HTTPS.',
  );
}
