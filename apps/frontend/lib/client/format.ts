export function trimAmount(value: string, minDecimals = 2): string {
  const [whole, fraction = ''] = value.split('.');
  let trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length < minDecimals) trimmed = trimmed.padEnd(minDecimals, '0');
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { hour12: false });
}
