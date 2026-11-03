const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export const PRICE_SCALE = 2;
export const PRICE_INTEGER_DIGITS = 16;
export const QUANTITY_SCALE = 8;
export const QUANTITY_INTEGER_DIGITS = 10;

export function isPositiveDecimal(value: unknown, integerDigits: number, scale: number): boolean {
  if (typeof value !== 'string') return false;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) return false;
  const [, whole, fraction = ''] = match;
  if (whole.replace(/^0+(?=\d)/, '').length > integerDigits) return false;
  if (fraction.length > scale) return false;
  return /[1-9]/.test(whole + fraction);
}

export function toUnits(value: string, scale: number): bigint {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const [, whole, fraction = ''] = match;
  if (fraction.length > scale) throw new Error(`More than ${scale} decimal places: ${value}`);
  return BigInt(whole + fraction.padEnd(scale, '0'));
}

export function fromUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

export function normalizeDecimal(value: string, scale: number): string {
  return fromUnits(toUnits(value, scale), scale);
}
