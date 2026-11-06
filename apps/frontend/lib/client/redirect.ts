export function safeRedirect(target: string | null | undefined, fallback = '/orders'): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
    return fallback;
  }
  try {
    const url = new URL(target, 'http://exchange.invalid');
    const path = `${url.pathname}${url.search}`;
    const inside = url.origin === 'http://exchange.invalid' && !path.startsWith('//') && !path.startsWith('/\\');
    return inside ? path : fallback;
  } catch {
    return fallback;
  }
}
