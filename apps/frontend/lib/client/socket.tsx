'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Socket, io } from 'socket.io-client';
import { UNAUTHORIZED_EVENT, UnauthorizedDetail } from './api';
import { waitForToken } from './ws-token';
import { useSession } from './session';

const SocketContext = createContext<Socket | null>(null);

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const userId = user?.id;
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (loading) return;
    const signedIn = Boolean(userId);
    let closed = false;
    const connection = io(process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001', {
      transports: ['websocket'],
      auth: (deliver) => {
        if (!signedIn) return deliver({});
        const startedAt = performance.now();
        void waitForToken({
          fetchToken: () => fetch('/api/ws-token', { cache: 'no-store' }),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          cancelled: () => closed,
        }).then((outcome) => {
          if (outcome.kind === 'token') return deliver({ token: outcome.token });
          if (outcome.kind === 'signedOut' && !closed) {
            window.dispatchEvent(new CustomEvent<UnauthorizedDetail>(UNAUTHORIZED_EVENT, { detail: { startedAt } }));
          }
        });
      },
    });
    let retry: ReturnType<typeof setTimeout> | undefined;
    connection.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') connection.connect();
    });
    connection.on('connect_error', () => {
      if (connection.active) return;
      clearTimeout(retry);
      retry = setTimeout(() => connection.connect(), 2_000);
    });
    setSocket(connection);
    return () => {
      closed = true;
      clearTimeout(retry);
      connection.disconnect();
      connection.removeAllListeners();
      setSocket(null);
    };
  }, [userId, loading]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}
