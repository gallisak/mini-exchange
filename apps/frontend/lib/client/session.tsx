'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SESSION_CHANGED_EVENT, UNAUTHORIZED_EVENT, UnauthorizedDetail, api, showingUser } from './api';
import { singleFlight } from './latest';
import { checkSession } from './session-check';
import { answeredForCurrentSession } from './session-order';
import { User } from './types';

interface SessionValue {
  user: User | null;
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
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const signedInAt = useRef(0);
  const latestUser = useRef<User | null>(null);
  const shownBefore = useRef<User | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  latestUser.current = user;
  showingUser(user?.id ?? null);

  const isSignedIn = useCallback((userId: string) => latestUser.current?.id === userId, []);

  useEffect(() => {
    const before = shownBefore.current;
    shownBefore.current = user;
    if (before?.id === user?.id) return;
    toast.dismiss();
    if (before && user) toast.message(`This browser is now signed in as ${user.email}`);
  }, [user]);

  const recheck = useMemo(
    () =>
      singleFlight(async () => {
        const started = generation.current;
        const body = await api<{ user: User | null }>('/api/auth/session').catch(() => null);
        if (!body || generation.current !== started) return;
        setUser(body.user);
        setLoading(false);
      }),
    [],
  );

  const refresh = useCallback(async () => {
    const started = generation.current;
    const current = () => generation.current === started;
    const outcome = await checkSession(
      () => api<{ user: User | null }>('/api/auth/session').then((body) => body.user),
      current,
    );
    if (!outcome) return;
    setUser(outcome.user);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const signedOut = (event: Event) => {
      const startedAt = (event as CustomEvent<UnauthorizedDetail>).detail?.startedAt;
      if (answeredForCurrentSession(startedAt, signedInAt.current)) setUser(null);
    };
    const check = () => {
      if (document.visibilityState === 'visible') void recheck();
    };
    const announced = sessionChannel();
    channel.current = announced;
    announced?.addEventListener('message', () => void recheck());
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    window.addEventListener(SESSION_CHANGED_EVENT, check);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      announced?.close();
      channel.current = null;
      window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
      window.removeEventListener(SESSION_CHANGED_EVENT, check);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [refresh, recheck]);

  const signIn = useCallback(async (mode: 'login' | 'register', email: string, password: string) => {
    const { user: signedIn } = await api<{ user: User }>(`/api/auth/${mode}`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      endsSessionOn401: false,
    });
    generation.current += 1;
    signedInAt.current = performance.now();
    setUser(signedIn);
    setLoading(false);
    channel.current?.postMessage('changed');
    return signedIn;
  }, []);

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    generation.current += 1;
    setUser(null);
    setLoading(false);
    channel.current?.postMessage('changed');
  }, []);

  return (
    <SessionContext.Provider value={{ user, loading, isSignedIn, signIn, signOut, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
