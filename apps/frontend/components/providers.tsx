'use client';

import { Toaster } from '@/components/ui/sonner';
import { SessionProvider } from '@/lib/client/session';
import { SocketProvider } from '@/lib/client/socket';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <SocketProvider>
        {children}
        <Toaster richColors position="bottom-right" />
      </SocketProvider>
    </SessionProvider>
  );
}
