import { createHash } from 'crypto';

const NAMESPACE = '6f1c7a52-3f2e-4b8e-9a43-1d2c5e7b9f10';

export function uuidV5(name: string, namespace: string = NAMESPACE): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
