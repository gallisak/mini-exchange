import { coalesced } from './latest';
import { checkSession } from './session-check';
import { answeredForCurrentSession } from './session-order';
import { User } from './types';

export interface SessionAnswer {
  user: User | null;
  session: string | null;
}

interface Deps {
  remembered: string | null;
  read: () => Promise<SessionAnswer>;
  pin: (session: string | null) => void;
  show: (answer: SessionAnswer) => void;
  settled: () => void;
  now: () => number;
  wait?: (ms: number) => Promise<void>;
}

export const FOCUS_CHECK_EVERY_MS = 30_000;
const START_RETRIES = 4;
const RECHECK_RETRIES = 1;
const NOBODY: SessionAnswer = { user: null, session: null };

export function trackSession({ remembered, read, pin, show, settled, now, wait }: Deps) {
  let shown: SessionAnswer = { user: null, session: remembered };
  let generation = 0;
  let signedInAt = 0;
  let focusCheckedAt = -Infinity;

  const present = (answer: SessionAnswer) => {
    shown = answer;
    pin(answer.session);
    show(answer);
    settled();
  };

  const newSession = (answer: SessionAnswer) => {
    generation += 1;
    signedInAt = now();
    present(answer);
  };

  const apply = (answer: SessionAnswer) => {
    if (answer.session !== shown.session || answer.user?.id !== shown.user?.id) return newSession(answer);
    const sameDetails = answer.user?.email === shown.user?.email && answer.user?.role === shown.user?.role;
    if (sameDetails) settled();
    else present(answer);
  };

  const loadSession = async ({ retries }: { retries: number }) => {
    const started = generation;
    const outcome = await checkSession(read, () => generation === started, retries, wait);
    if (outcome && 'answer' in outcome) apply(outcome.answer);
    return outcome;
  };

  const recheck = coalesced(async () => {
    await loadSession({ retries: RECHECK_RETRIES });
  });

  return {
    recheck,
    signedIn: newSession,
    async refresh() {
      const outcome = await loadSession({ retries: START_RETRIES });
      if (outcome && 'failed' in outcome) apply(NOBODY);
    },
    signedOut() {
      generation += 1;
      present(NOBODY);
    },
    refused(startedAt: number | undefined) {
      if (answeredForCurrentSession(startedAt, signedInAt)) apply(NOBODY);
    },
    focused() {
      if (now() - focusCheckedAt < FOCUS_CHECK_EVERY_MS) return Promise.resolve();
      focusCheckedAt = now();
      return recheck();
    },
    announced(session: unknown) {
      if (typeof session === 'string') pin(session);
      return recheck();
    },
  };
}
