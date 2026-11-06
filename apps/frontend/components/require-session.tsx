'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingRows } from '@/components/states';
import { useSession } from '@/lib/client/session';
import { User } from '@/lib/client/types';

export function RequireSession({
  admin = false,
  children,
}: {
  admin?: boolean;
  children: (user: User) => React.ReactNode;
}) {
  const { user, loading } = useSession();
  const pathname = usePathname();

  if (loading) return <LoadingRows rows={6} />;
  if (!user || (admin && user.role !== 'admin')) {
    return (
      <Card className="mx-auto mt-10 max-w-md text-center">
        <CardHeader>
          <Lock className="mx-auto h-8 w-8 text-muted-foreground" />
          <CardTitle>{user ? 'Admins only' : 'Sign in to continue'}</CardTitle>
          <CardDescription>
            {user
              ? 'This page shows the state of the whole exchange.'
              : 'Your orders and wallet are private to your account.'}
          </CardDescription>
        </CardHeader>
        {!user && (
          <CardContent>
            <Button asChild>
              <Link href={`/login?next=${encodeURIComponent(pathname)}`}>Sign in</Link>
            </Button>
          </CardContent>
        )}
      </Card>
    );
  }
  return <Fragment key={user.id}>{children(user)}</Fragment>;
}
