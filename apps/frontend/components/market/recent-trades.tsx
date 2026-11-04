'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { formatTime, trimAmount } from '@/lib/client/format';
import { useTrades } from '@/lib/client/use-trades';

export function RecentTrades({ instrument }: { instrument: string }) {
  const { trades, error, reload } = useTrades(instrument);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Recent trades</CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : trades === null ? (
          <LoadingRows />
        ) : trades.length === 0 ? (
          <EmptyState title="No trades yet" hint="Trades appear here the moment orders match." />
        ) : (
          <div className="max-h-[520px] overflow-y-auto">
            <div className="grid grid-cols-3 pb-2 text-xs font-medium uppercase text-muted-foreground">
              <span>Price</span>
              <span className="text-right">Quantity</span>
              <span className="text-right">Time</span>
            </div>
            {trades.map((trade) => (
              <div
                key={trade.id}
                className="grid grid-cols-3 py-1 font-mono text-sm tabular-nums"
                data-testid="trade"
              >
                <span>{trade.price}</span>
                <span className="text-right">{trimAmount(trade.quantity, 2)}</span>
                <span className="text-right text-muted-foreground">{formatTime(trade.executedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
