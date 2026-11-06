import { describe, expect, it, vi } from 'vitest';
import { isSending, onSendingChange, startSending } from './sending';

describe('an order that is still on its way', () => {
  it('stays known as sending to every form until each of its sends got an answer', () => {
    const listener = vi.fn();
    const stop = onSendingChange(listener);
    const first = startSending('k1');
    const again = startSending('k1');

    first();
    first();
    expect(isSending('k1')).toBe(true);
    again();

    expect(isSending('k1')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    stop();
  });
});
