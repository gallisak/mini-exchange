'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { RequireSession } from '@/components/require-session';
import { api } from '@/lib/client/api';
import { trimAmount } from '@/lib/client/format';
import { useSocket } from '@/lib/client/socket';
import { Balance, ResyncScope, resyncsEverything } from '@/lib/client/types';
import { cn } from '@/lib/utils';

function Wallet() {
  const socket = useSocket();
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setBalances((await api<{ balances: Balance[] }>('/api/wallet')).balances);
      setUpdatedAt(new Date());
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onChange = () => void load();
    const onResync = (scope?: ResyncScope) => {
      if (resyncsEverything(scope)) void load();
    };
    socket.on('wallet', onChange);
    socket.on('connect', onChange);
    socket.on('resync', onResync);
    return () => {
      socket.off('wallet', onChange);
      socket.off('connect', onChange);
      socket.off('resync', onResync);
    };
  }, [socket, load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
        <p className="text-sm text-muted-foreground">
          Balances from the ledger. They update the moment a trade of yours is settled.
        </p>
      </div>
      <Card className="max-w-2xl">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Balances</CardTitle>
            <CardDescription>
              {updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour12: false })}` : '…'}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {error ? (
            <ErrorState message={error} onRetry={load} />
          ) : balances === null ? (
            <LoadingRows rows={4} />
          ) : balances.length === 0 ? (
            <EmptyState title="No balances yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((row) => (
                  <TableRow key={row.asset} data-testid="balance-row">
                    <TableCell className="font-medium">{row.asset}</TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-mono tabular-nums',
                        row.balance.startsWith('-') && 'text-destructive',
                      )}
                    >
                      {trimAmount(row.balance, row.asset === 'USD' ? 2 : 0)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function WalletPage() {
  return <RequireSession>{() => <Wallet />}</RequireSession>;
}
