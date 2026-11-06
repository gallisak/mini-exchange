'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { api, endsSession } from '@/lib/client/api';
import { subtractDecimals } from '@/lib/client/decimal';
import { formatDateTime, trimAmount } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import { Order, OrderStatus } from '@/lib/client/types';
import { cn } from '@/lib/utils';

const ACTIVE: OrderStatus[] = ['open', 'partially_filled'];
const CANCEL_AGAIN_AFTER_MS = 5_000;

const STATUS_LOOK: Record<OrderStatus, 'default' | 'secondary' | 'outline'> = {
  open: 'default',
  partially_filled: 'default',
  filled: 'secondary',
  cancelled: 'outline',
};

export function OrdersTable({
  orders,
  error,
  reload,
}: {
  orders: Order[] | null;
  error: string | null;
  reload: () => void;
}) {
  const [view, setView] = useState<'active' | 'history'>('active');
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const { user, isSignedIn } = useSession();

  async function cancel(order: Order) {
    const sentBy = user?.id ?? '';
    const enable = () =>
      setCancelling((current) => {
        const next = new Set(current);
        next.delete(order.id);
        return next;
      });
    setCancelling((current) => new Set(current).add(order.id));
    try {
      await api(`/api/orders/${order.id}`, { method: 'DELETE' });
      if (isSignedIn(sentBy)) {
        toast.message(`Cancelling ${order.side} ${order.instrument} @ ${order.price}`);
      }
      setTimeout(enable, CANCEL_AGAIN_AFTER_MS);
    } catch (failure) {
      if (isSignedIn(sentBy) && !endsSession(failure)) toast.error((failure as Error).message);
      enable();
    }
  }

  const shown = (orders ?? []).filter((order) =>
    view === 'active' ? ACTIVE.includes(order.status) : !ACTIVE.includes(order.status),
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Your orders</CardTitle>
        <Tabs value={view} onValueChange={(value) => setView(value as 'active' | 'history')}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="history">Filled &amp; cancelled</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && orders !== null && (
          <ErrorState message={`Showing the orders that loaded last: ${error}`} onRetry={reload} />
        )}
        {error && orders === null ? (
          <ErrorState message={error} onRetry={reload} />
        ) : orders === null ? (
          <LoadingRows />
        ) : shown.length === 0 ? (
          <EmptyState
            title={view === 'active' ? 'No active orders' : 'No finished orders yet'}
            hint={view === 'active' ? 'Orders you place show up here until they fill.' : undefined}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Placed</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Filled / Quantity</TableHead>
                <TableHead>Status</TableHead>
                {view === 'active' && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((order) => {
                const filled = subtractDecimals(order.quantity, order.remainingQuantity);
                return (
                  <TableRow key={order.id} data-testid="order-row">
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(order.createdAt)}
                    </TableCell>
                    <TableCell>{order.instrument}</TableCell>
                    <TableCell
                      className={cn('capitalize', order.side === 'buy' ? 'text-buy' : 'text-sell')}
                    >
                      {order.side}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{order.price}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {trimAmount(filled, 0)} / {trimAmount(order.quantity, 0)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_LOOK[order.status]}>
                        {order.status.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    {view === 'active' && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancelling.has(order.id)}
                          onClick={() => cancel(order)}
                          aria-label={`Cancel ${order.side} ${order.quantity} ${order.instrument} at ${order.price}, placed ${formatDateTime(order.createdAt)}`}
                        >
                          <X className="mr-1 h-4 w-4" />
                          Cancel
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
