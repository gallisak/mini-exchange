import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { FOCUS_CHECK_EVERY_MS, SessionAnswer, trackSession } from './session-tracker';

const signedInAs = (name: string, role: 'user' | 'admin' = 'user'): SessionAnswer => ({
  user: { id: `id-${name}`, email: `${name}@example.com`, role },
  session: `session-${name}`,
});
const nobody: SessionAnswer = { user: null, session: null };

function tracked(reads: (SessionAnswer | Error | Promise<SessionAnswer>)[], remembered: string | null = null) {
  let time = 1_000;
  const shown: SessionAnswer[] = [];
  const pins: (string | null)[] = [];
  const read = vi.fn(async (_session: string | null) => {
    const next = reads.length > 1 ? reads.shift() : reads[0];
    if (next instanceof Error) throw next;
    return next as SessionAnswer | Promise<SessionAnswer>;
  });
  const settled = vi.fn();
  const tracker = trackSession({
    remembered,
    read,
    pin: (session) => pins.push(session),
    show: (answer) => shown.push(answer),
    settled,
    now: () => time,
    wait: async () => undefined,
  });
  return { tracker, read, shown, pins, settled, pass: (ms: number) => (time += ms) };
}

const held = () => {
  let answer!: (value: SessionAnswer) => void;
  const promise = new Promise<SessionAnswer>((resolve) => (answer = resolve));
  return { promise, answer };
};

describe('following the session of a tab', () => {
  it('shows and pins the sign-in the first check finds', async () => {
    const { tracker, shown, pins, settled } = tracked([signedInAs('a')]);

    await tracker.refresh();

    expect(shown).toEqual([signedInAs('a')]);
    expect(pins).toEqual(['session-a']);
    expect(settled).toHaveBeenCalled();
  });

  it('keeps a user after a late refusal of a request sent before a recheck moved the tab to another account', async () => {
    const { tracker, shown, pass } = tracked([signedInAs('a'), signedInAs('x')]);
    await tracker.refresh();
    pass(10);
    const sentAt = 1_010;
    pass(10);

    await tracker.recheck();
    tracker.refused(sentAt);

    expect(shown.at(-1)).toEqual(signedInAs('x'));
  });

  it('takes a refusal of a request sent after the last change as the end of the session', async () => {
    const { tracker, shown, pass } = tracked([signedInAs('a')]);
    await tracker.refresh();
    pass(10);

    tracker.refused(1_010);

    expect(shown.at(-1)).toEqual(nobody);
  });

  it('does not let a first check that is still retrying replace what a recheck found', async () => {
    const slow = held();
    const { tracker, shown } = tracked([slow.promise, signedInAs('x')]);
    const first = tracker.refresh();

    await tracker.recheck();
    slow.answer(signedInAs('a'));
    await first;

    expect(shown).toEqual([signedInAs('x')]);
  });

  it('makes one more request for a signal that came during a recheck, and ends on its answer', async () => {
    const stale = held();
    const { tracker, read, shown } = tracked([stale.promise, signedInAs('b')]);

    const first = tracker.recheck();
    const second = tracker.recheck();
    stale.answer(signedInAs('a'));
    await Promise.all([first, second]);

    expect(read).toHaveBeenCalledTimes(2);
    expect(shown.at(-1)).toEqual(signedInAs('b'));
  });

  it('tries a failed recheck once more instead of losing the news', async () => {
    const { tracker, read, shown } = tracked([new ApiError(503, 'down'), signedInAs('b')]);

    await tracker.recheck();

    expect(read).toHaveBeenCalledTimes(2);
    expect(shown).toEqual([signedInAs('b')]);
  });

  it('keeps the user shown when a recheck fails twice', async () => {
    const { tracker, shown } = tracked([signedInAs('a'), new ApiError(503, 'down')]);
    await tracker.refresh();

    await tracker.recheck();

    expect(shown).toEqual([signedInAs('a')]);
  });

  it('counts as signed out when the first check never gets an answer', async () => {
    const { tracker, settled } = tracked([new ApiError(503, 'down')]);

    await tracker.refresh();

    expect(settled).toHaveBeenCalled();
  });

  it('does not render again when a recheck finds the same user', async () => {
    const { tracker, shown } = tracked([signedInAs('a')]);
    await tracker.refresh();

    await tracker.recheck();

    expect(shown).toHaveLength(1);
  });

  it('shows a changed role of the same sign-in', async () => {
    const { tracker, shown } = tracked([signedInAs('a'), signedInAs('a', 'admin')]);
    await tracker.refresh();

    await tracker.recheck();

    expect(shown.at(-1)?.user?.role).toBe('admin');
  });

  it('checks on focus at most every half minute', async () => {
    const { tracker, read, pass } = tracked([signedInAs('a')]);

    await tracker.focused();
    await tracker.focused();
    expect(read).toHaveBeenCalledTimes(1);

    pass(FOCUS_CHECK_EVERY_MS);
    await tracker.focused();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never holds back a sign-in announced by another tab or a refused request', async () => {
    const { tracker, read } = tracked([signedInAs('a')]);
    await tracker.focused();

    await tracker.announced('session-b');
    await tracker.recheck();

    expect(read).toHaveBeenCalledTimes(3);
  });

  it('asks for the sign-in another tab announced, even if the old cookies are still there', async () => {
    const { tracker, read, pins } = tracked([signedInAs('b')]);

    await tracker.announced('session-b');

    expect(read).toHaveBeenCalledWith('session-b');
    expect(pins).toEqual(['session-b']);
  });

  it('keeps sending requests for the account it shows until it shows the one another tab announced', async () => {
    const answer = held();
    const { tracker, pins } = tracked([signedInAs('a'), answer.promise]);
    await tracker.refresh();

    const checking = tracker.announced('session-b');
    await Promise.resolve();

    expect(pins).toEqual(['session-a']);
    answer.answer(signedInAs('b'));
    await checking;
    expect(pins).toEqual(['session-a', 'session-b']);
  });

  it('does not move requests to an announced sign-in it could not check, and asks for it next time', async () => {
    const { tracker, read, pins, shown } = tracked([
      signedInAs('a'),
      new ApiError(503, 'down'),
      new ApiError(503, 'down'),
      signedInAs('b'),
    ]);
    await tracker.refresh();

    await tracker.announced('session-b');

    expect(pins).toEqual(['session-a']);
    expect(shown.at(-1)).toEqual(signedInAs('a'));

    await tracker.recheck();

    expect(read).toHaveBeenLastCalledWith('session-b');
    expect(shown.at(-1)).toEqual(signedInAs('b'));
  });

  it('stops asking for an announced sign-in once it is shown, or when the other tab signed out', async () => {
    const { tracker, read } = tracked([signedInAs('b'), signedInAs('b'), nobody]);

    await tracker.announced('session-b');
    await tracker.recheck();
    expect(read).toHaveBeenLastCalledWith(null);

    await tracker.announced('session-c');
    await tracker.announced(null);
    expect(read).toHaveBeenLastCalledWith(null);
  });

  it('ignores a check that was running when the user signed in', async () => {
    const slow = held();
    const { tracker, shown } = tracked([slow.promise]);
    const running = tracker.recheck();

    tracker.signedIn(signedInAs('b'));
    slow.answer(signedInAs('a'));
    await running;

    expect(shown).toEqual([signedInAs('b')]);
  });

  it('unpins a remembered sign-in that is over', async () => {
    const { tracker, pins } = tracked([nobody], 'session-old');

    await tracker.refresh();

    expect(pins).toEqual([null]);
  });
});
