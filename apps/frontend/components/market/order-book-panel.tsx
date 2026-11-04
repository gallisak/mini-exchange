'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConnectionBadge } from '@/components/connection-badge';
import { LoadingRows } from '@/components/states';
import { useOrderBook } from '@/lib/client/use-order-book';
import { OrderBookTable } from './order-book-table';

export function OrderBookPanel({ instrument }: { instrument: string }) {
  const book = useOrderBook(instrument);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">Order book</CardTitle>
          <CardDescription>
            {book.seq === null ? 'Waiting for the first snapshot' : `Sequence ${book.seq}`}
            {book.resyncs > 0 && ` · resynced ${book.resyncs}×`}
          </CardDescription>
        </div>
        <ConnectionBadge status={book.status} />
      </CardHeader>
      <CardContent className="px-0">
        {book.seq === null ? (
          <div className="px-6">
            <LoadingRows rows={8} />
          </div>
        ) : (
          <OrderBookTable bids={book.bids} asks={book.asks} />
        )}
      </CardContent>
    </Card>
  );
}
