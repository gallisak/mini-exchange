import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { FIRST_RETRY_MS, FOCUS_CHECK_EVERY_MS, LONGEST_RETRY_MS, SessionAnswer, trackSession } from './session-tracker';

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
  const unchecked = vi.fn();
  const retries: { ms: number; run: () => Promise<void> }[] = [];
  const tracker = trackSession({
    remembered,
    read,
    pin: (session) => pins.push(session),
    show: (answer) => shown.push(answer),
    settled,
    unchecked,
    now: () => time,
    wait: async () => undefined,
    schedule: (ms, run) => retries.push({ ms, run }),
  });
  const retry = () => (retries.shift() as { run: () => Promise<void> }).run();
  return { tracker, read, shown, pins, settled, unchecked, retries, retry, pass: (ms: number) => (time += ms) };
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
    const { tracker, shown, pass } = tracked([signedInAs('a'), nobody]);
    await tracker.refresh();
    pass(10);

    const checking = tracker.refused(1_010);
    expect(shown.at(-1)).toEqual(nobody);
    await checking;

    expect(shown.at(-1)).toEqual(nobody);
  });

  it('moves to another sign-in of the browser after a refusal, even when the refusal overtook a check that found it', async () => {
    const slow = held();
    const { tracker, read, shown, pass } = tracked([signedInAs('b'), slow.promise, signedInAs('a')]);
    await tracker.refresh();
    pass(10);

    const checking = tracker.recheck();
    const refusing = tracker.refused(1_005);
    slow.answer(signedInAs('a'));
    await Promise.all([checking, refusing]);

    expect(read).toHaveBeenCalledTimes(3);
    expect(shown.at(-1)).toEqual(signedInAs('a'));
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

  it('checks again later after a recheck failed, so a change it missed still reaches the tab', async () => {
    const down = new ApiError(503, 'down');
    const { tracker, shown, retries, retry } = tracked([signedInAs('a'), down, down, signedInAs('b')]);
    await tracker.refresh();
    await tracker.recheck();

    expect(retries.map(({ ms }) => ms)).toEqual([FIRST_RETRY_MS]);
    await retry();

    expect(shown.at(-1)).toEqual(signedInAs('b'));
    expect(retries).toEqual([]);
  });

  it('keeps one retry waiting at a time, however many checks fail meanwhile', async () => {
    const { tracker, retries } = tracked([signedInAs('a'), new ApiError(503, 'down')]);
    await tracker.refresh();

    await tracker.recheck();
    await tracker.recheck();

    expect(retries).toHaveLength(1);
  });

  it('keeps the remembered sign-in and says it could not check when the first check never gets an answer', async () => {
    const { tracker, shown, pins, settled, unchecked, retries } = tracked([new ApiError(503, 'down')], 'session-a');

    await tracker.refresh();

    expect(unchecked).toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
    expect(pins).toEqual([]);
    expect(retries.map(({ ms }) => ms)).toEqual([FIRST_RETRY_MS]);
  });

  it('keeps trying a first check that failed, waiting longer each time, and shows the sign-in once it gets an answer', async () => {
    const down = new ApiError(503, 'down');
    const { tracker, shown, pins, settled, retries, retry } = tracked(
      [down, down, down, down, down, ...Array.from({ length: 8 }, () => down), signedInAs('a')],
      'session-a',
    );
    await tracker.refresh();

    const pauses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      pauses.push(retries[0].ms);
      await retry();
    }
    expect(pauses).toEqual([FIRST_RETRY_MS, 2 * FIRST_RETRY_MS, 4 * FIRST_RETRY_MS, LONGEST_RETRY_MS]);
    expect(retries.map(({ ms }) => ms)).toEqual([LONGEST_RETRY_MS]);
    await retry();

    expect(shown).toEqual([signedInAs('a')]);
    expect(pins).toEqual(['session-a']);
    expect(settled).toHaveBeenCalled();
    expect(retries).toEqual([]);
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

  it('stops asking for an announced sign-in that turned out to be over', async () => {
    const { tracker, read, shown } = tracked([signedInAs('a')]);
    await tracker.refresh();

    await tracker.announced('session-b');
    await tracker.recheck();

    expect(read.mock.calls.map(([session]) => session)).toEqual([null, 'session-b', null]);
    expect(shown.at(-1)).toEqual(signedInAs('a'));
  });

  it('still asks for a sign-in announced while an earlier check was running', async () => {
    const slow = held();
    const { tracker, read, shown } = tracked([slow.promise, signedInAs('b')]);
    const running = tracker.recheck();

    const announcing = tracker.announced('session-b');
    slow.answer(signedInAs('a'));
    await Promise.all([running, announcing]);

    expect(read.mock.calls.map(([session]) => session)).toEqual([null, 'session-b']);
    expect(shown.at(-1)).toEqual(signedInAs('b'));
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
