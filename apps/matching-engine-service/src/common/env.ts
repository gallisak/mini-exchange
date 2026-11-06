export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function trustedProxies(): string[] {
  return (process.env.TRUST_PROXY ?? 'loopback, uniquelocal')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function corsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${min}, got "${raw}"`);
  }
  return value;
}

const PLACEHOLDER = /^change-me/i;

export function refuseSharedSecret(first: string, second: string): void {
  if (process.env[first] === process.env[second]) {
    throw new Error(`${first} and ${second} must differ, or a token of one kind passes as the other`);
  }
}

export function refusePlaceholderSecrets(names: string[]): void {
  if (process.env.NODE_ENV !== 'production') return;
  for (const name of names) {
    if (PLACEHOLDER.test(process.env[name] ?? '')) {
      throw new Error(`${name} still has the placeholder value from .env.example, set a real secret`);
    }
  }
}
