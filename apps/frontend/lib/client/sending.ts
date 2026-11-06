const sending = new Map<string, number>();
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((listener) => listener());

export function startSending(key: string): () => void {
  sending.set(key, (sending.get(key) ?? 0) + 1);
  changed();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (sending.get(key) ?? 1) - 1;
    if (left > 0) sending.set(key, left);
    else sending.delete(key);
    changed();
  };
}

export function isSending(key: string | undefined): boolean {
  return key !== undefined && sending.has(key);
}

export function onSendingChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
