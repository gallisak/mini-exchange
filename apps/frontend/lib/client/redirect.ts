export function safeRedirect(target: string | null | undefined, fallback = '/orders'): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
    return fallback;
  }
  try {
    const url = new URL(target, 'http://exchange.invalid');
    return url.origin === 'http://exchange.invalid' ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}
