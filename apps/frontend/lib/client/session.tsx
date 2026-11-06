'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNAUTHORIZED_EVENT, UnauthorizedDetail, api } from './api';
import { checkSession } from './session-check';
import { answeredForCurrentSession } from './session-order';
import { User } from './types';

interface SessionValue {
  user: User | null;
  loading: boolean;
  signIn: (mode: 'login' | 'register', email: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const signedInAt = useRef(0);

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
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  }, [refresh]);

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
    return signedIn;
  }, []);

  const signOut = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    generation.current += 1;
    setUser(null);
    setLoading(false);
  }, []);

  return (
    <SessionContext.Provider value={{ user, loading, signIn, signOut, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
