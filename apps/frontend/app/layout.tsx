import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = {
  title: 'Mini Exchange',
  description: 'Limit order matching with live depth, settlement and reconciliation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Providers>
          <SiteHeader />
          <main className="container py-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
