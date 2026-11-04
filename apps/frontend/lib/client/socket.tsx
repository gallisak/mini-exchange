'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Socket, io } from 'socket.io-client';
import { UNAUTHORIZED_EVENT } from './api';
import { useSession } from './session';

const SocketContext = createContext<Socket | null>(null);

async function handshakeToken(): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch('/api/ws-token', { cache: 'no-store' }).catch(() => null);
    if (response?.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      return null;
    }
    if (response?.ok) return ((await response.json()) as { token: string | null }).token;
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  return null;
}

export function SocketProvider({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const userId = user?.id;
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (loading) return;
    const signedIn = Boolean(userId);
    const connection = io(process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001', {
      transports: ['websocket'],
      auth: (deliver) => {
        if (!signedIn) return deliver({});
        void handshakeToken().then((token) => deliver(token ? { token } : {}));
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
      clearTimeout(retry);
      connection.removeAllListeners();
      connection.disconnect();
      setSocket(null);
    };
  }, [userId, loading]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}
