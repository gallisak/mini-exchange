'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SESSION_HEADER } from '@/lib/session-id';
import { SESSION_CHANGED_EVENT, UNAUTHORIZED_EVENT, UnauthorizedDetail, api, rememberedSession, showingSession } from './api';
import { SessionAnswer, trackSession } from './session-tracker';
import { User } from './types';

interface SessionValue {
  user: User | null;
  session: string | null;
  loading: boolean;
  isSignedIn: (userId: string) => boolean;
  signIn: (mode: 'login' | 'register', email: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);
const SESSION_CHANNEL = 'mx:session';

function sessionChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL);
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latestUser = useRef<User | null>(null);
  const shownBefore = useRef<User | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  latestUser.current = user;

  const tracker = useMemo(
    () =>
      trackSession({
        remembered: rememberedSession(),
        read: (session) =>
          api<SessionAnswer>('/api/auth/session', session ? { headers: { [SESSION_HEADER]: session } } : {}),
        pin: showingSession,
        show: (answer) => {
          setUser(answer.user);
          setSession(answer.session);
        },
        settled: () => setLoading(false),
        now: () => performance.now(),
      }),
    [],
  );

  const isSignedIn = useCallback((userId: string) => latestUser.current?.id === userId, []);

  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = user;
    if (before?.id === user?.id) return;
    toast.dismiss();
    if (before && user) toast.message(`This browser is now signed in as ${user.email}`);
  }, [user]);

  useEffect(() => {
    showingSession(rememberedSession());
    void tracker.refresh();
    const signedOut = (event: Event) => void tracker.refused((event as CustomEvent<UnauthorizedDetail>).detail?.startedAt);
    const focused = () => {
      if (document.visibilityState === 'visible') void tracker.focused();
    };
    const changed = () => void tracker.recheck();
    const announced = sessionChannel();
    channel.current = announced;
    announced?.addEventListener('message', (event) => void tracker.announced(event.data));
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    window.addEventListener(SESSION_CHANGED_EVENT, changed);
    window.addEventListener('focus', focused);
    document.addEventListener('visibilitychange', focused);
    return () => {
      announced?.close();
      channel.current = null;
      window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
      window.removeEventListener(SESSION_CHANGED_EVENT, changed);
      window.removeEventListener('focus', focused);
      document.removeEventListener('visibilitychange', focused);
    };
  }, [tracker]);

  const signIn = useCallback(
    async (mode: 'login' | 'register', email: string, password: string) => {
      const answer = await api<SessionAnswer>(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        endsSessionOn401: false,
      });
      tracker.signedIn(answer);
      channel.current?.postMessage(answer.session);
      return answer.user as User;
    },
    [tracker],
  );

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    tracker.signedOut();
    channel.current?.postMessage(null);
  }, [tracker]);

  return (
    <SessionContext.Provider value={{ user, session, loading, isSignedIn, signIn, signOut, refresh: tracker.refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
