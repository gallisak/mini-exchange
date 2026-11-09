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
  read: (session: string | null) => Promise<SessionAnswer>;
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
  let announcedSession: string | null = null;

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
    let asked: string | null = null;
    const ask = () => {
      asked = announcedSession;
      return read(asked);
    };
    const outcome = await checkSession(ask, () => generation === started, retries, wait);
    if (outcome && 'answer' in outcome) {
      if (announcedSession === asked) announcedSession = null;
      apply(outcome.answer);
    }
    return outcome;
  };

  const recheck = coalesced(async () => {
    await loadSession({ retries: RECHECK_RETRIES });
  });

  return {
    recheck,
    signedIn(answer: SessionAnswer) {
      announcedSession = null;
      newSession(answer);
    },
    async refresh() {
      const outcome = await loadSession({ retries: START_RETRIES });
      if (outcome && 'failed' in outcome) apply(NOBODY);
    },
    signedOut() {
      announcedSession = null;
      generation += 1;
      present(NOBODY);
    },
    refused(startedAt: number | undefined) {
      if (!answeredForCurrentSession(startedAt, signedInAt)) return Promise.resolve();
      apply(NOBODY);
      return recheck();
    },
    focused() {
      if (now() - focusCheckedAt < FOCUS_CHECK_EVERY_MS) return Promise.resolve();
      focusCheckedAt = now();
      return recheck();
    },
    announced(session: unknown) {
      announcedSession = typeof session === 'string' ? session : null;
      return recheck();
    },
  };
}
