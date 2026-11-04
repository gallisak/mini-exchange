'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/states';
import { safeRedirect } from '@/lib/client/redirect';
import { useSession } from '@/lib/client/session';

function LoginForm() {
  const { signIn } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(mode, email, password);
      router.push(safeRedirect(next));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto mt-10 w-full max-w-sm">
      <CardHeader>
        <CardTitle>{mode === 'login' ? 'Welcome back' : 'Create an account'}</CardTitle>
        <CardDescription>
          New accounts start with 100,000 USD and 1,000 of each instrument.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={mode} onValueChange={(value) => setMode(value as 'login' | 'register')}>
          <TabsList className="mb-4 grid w-full grid-cols-2">
            <TabsTrigger value="login">Sign in</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
        </Tabs>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && <ErrorState message={error} />}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
