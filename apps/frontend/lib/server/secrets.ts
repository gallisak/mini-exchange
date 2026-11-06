const PLACEHOLDER = /^change-me/i;

export function refusePlaceholderSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (PLACEHOLDER.test(process.env.FRONTEND_PROXY_KEY ?? '')) {
    throw new Error('FRONTEND_PROXY_KEY still has the placeholder value from .env.example, set a real secret');
  }
}
