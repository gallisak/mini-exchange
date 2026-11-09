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
  unchecked: () => void;
  now: () => number;
  wait?: (ms: number) => Promise<void>;
  schedule?: (ms: number, run: () => Promise<void>) => void;
}

export const FOCUS_CHECK_EVERY_MS = 30_000;
export const FIRST_RETRY_MS = 5_000;
export const LONGEST_RETRY_MS = 30_000;
const START_RETRIES = 4;
const RECHECK_RETRIES = 1;
const NOBODY: SessionAnswer = { user: null, session: null };

const later = (ms: number, run: () => Promise<void>) => {
  setTimeout(() => void run(), ms);
};

export function trackSession({ remembered, read, pin, show, settled, unchecked, now, wait, schedule = later }: Deps) {
  let shown: SessionAnswer = { user: null, session: remembered };
  let pinned = remembered;
  let generation = 0;
  let signedInAt = 0;
  let focusCheckedAt = -Infinity;
  let announcedSession: string | null = null;
  let retryPause = 0;
  let retryPending = false;

  const pinTo = (session: string | null) => {
    pinned = session;
    pin(session);
  };

  pinTo(remembered);

  const present = (answer: SessionAnswer) => {
    shown = answer;
    if (answer.session) pinTo(answer.session);
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
    generation += 1;
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
      retryPause = 0;
      if (announcedSession === asked) announcedSession = null;
      const { session } = outcome.answer;
      const another = session !== null && pinned !== null && session !== pinned && session !== asked;
      apply(another ? NOBODY : outcome.answer);
    } else if (outcome) {
      retryLater();
    } else if (asked !== null && announcedSession === asked) {
      void recheck();
    }
    return outcome;
  };

  const recheck = coalesced(async () => {
    await loadSession({ retries: RECHECK_RETRIES });
  });

  const retryLater = () => {
    if (retryPending) return;
    retryPending = true;
    retryPause = Math.min(retryPause ? retryPause * 2 : FIRST_RETRY_MS, LONGEST_RETRY_MS);
    schedule(retryPause, () => {
      retryPending = false;
      return recheck();
    });
  };

  return {
    recheck,
    signedIn(answer: SessionAnswer) {
      announcedSession = null;
      newSession(answer);
    },
    async refresh() {
      const started = generation;
      const outcome = await loadSession({ retries: START_RETRIES });
      if (outcome && 'failed' in outcome && generation === started) unchecked();
    },
    signedOut() {
      announcedSession = null;
      generation += 1;
      pinTo(null);
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
