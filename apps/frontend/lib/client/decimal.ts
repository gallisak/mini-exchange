const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function parse(value: string): { units: bigint; scale: number } {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`Not a decimal: ${value}`);
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(whole + fraction);
  return { units: sign === '-' ? -units : units, scale: fraction.length };
}

function format(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export const MAX_ORDER_NOTIONAL = 10n ** 15n;

export function notionalAbove(price: string, quantity: string, limit = MAX_ORDER_NOTIONAL): boolean {
  if (!DECIMAL.test(price.trim()) || !DECIMAL.test(quantity.trim())) return false;
  const left = parse(price);
  const right = parse(quantity);
  return left.units * right.units > limit * 10n ** BigInt(left.scale + right.scale);
}

export function subtractDecimals(a: string, b: string): string {
  const left = parse(a);
  const right = parse(b);
  const scale = Math.max(left.scale, right.scale);
  const align = (value: { units: bigint; scale: number }) =>
    value.units * 10n ** BigInt(scale - value.scale);
  return format(align(left) - align(right), scale);
}
