import { describe, expect, it } from 'vitest';
import { latestRequest, singleFlight } from './latest';

describe('the latest of several overlapping requests', () => {
  it('is the only one whose answer may be shown, whatever order the answers come in', () => {
    const begin = latestRequest();
    const older = begin();
    const newer = begin();

    expect(newer.latest()).toBe(true);
    expect(older.latest()).toBe(false);
  });

  it('shows a success that arrives while a newer request is still running, so its failure has data to sit next to', () => {
    const begin = latestRequest();
    const older = begin();
    const newer = begin();

    expect(older.show()).toBe(true);
    expect(newer.latest()).toBe(true);
  });

  it('never replaces a newer answer with an older one', () => {
    const begin = latestRequest();
    const older = begin();
    const newer = begin();

    expect(newer.show()).toBe(true);
    expect(older.show()).toBe(false);
  });

  it('shows the newer of two answers that arrive in order', () => {
    const begin = latestRequest();
    const older = begin();
    const newer = begin();

    expect(older.show()).toBe(true);
    expect(newer.show()).toBe(true);
  });

  it('is not started again while the previous one is still running, so a slow answer is still shown', async () => {
    let finish!: (value: string) => void;
    let runs = 0;
    const load = singleFlight(() => {
      runs += 1;
      return new Promise<string>((resolve) => (finish = resolve));
    });

    const first = load();
    const overlapping = load();
    finish('slow answer');

    expect(await first).toBe('slow answer');
    expect(await overlapping).toBe('slow answer');
    expect(runs).toBe(1);
    void load();
    expect(runs).toBe(2);
  });
});
