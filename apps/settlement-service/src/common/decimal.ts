const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

export const PRICE_SCALE = 2;
export const PRICE_INTEGER_DIGITS = 16;
export const QUANTITY_SCALE = 8;
export const QUANTITY_INTEGER_DIGITS = 10;
export const LEDGER_SCALE = PRICE_SCALE + QUANTITY_SCALE;

export function isPositiveDecimal(value: unknown, integerDigits: number, scale: number): boolean {
  if (typeof value !== 'string') return false;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match || match[1] === '-') return false;
  const [, , whole, fraction = ''] = match;
  if (whole.replace(/^0+(?=\d)/, '').length > integerDigits) return false;
  if (fraction.length > scale) return false;
  return /[1-9]/.test(whole + fraction);
}

export function toUnits(value: string, scale: number): bigint {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const significant = fraction.replace(/0+$/, '');
  if (significant.length > scale) throw new Error(`More than ${scale} decimal places: ${value}`);
  const units = BigInt(whole + significant.padEnd(scale, '0'));
  return sign === '-' ? -units : units;
}

export function fromUnits(units: bigint, scale: number, minScale = scale): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  let fraction = digits.slice(digits.length - scale);
  while (fraction.length > minScale && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`;
}
