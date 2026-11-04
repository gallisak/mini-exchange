'use client';

import { Suspense } from 'react';
import { InstrumentSelect, useInstrument } from '@/components/instrument-select';
import { OrderBookPanel } from '@/components/market/order-book-panel';
import { RecentTrades } from '@/components/market/recent-trades';

function Market() {
  const instrument = useInstrument();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{instrument} market</h1>
          <p className="text-sm text-muted-foreground">
            Aggregated depth and trades, updated live with a sequence number on every change.
          </p>
        </div>
        <InstrumentSelect />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <OrderBookPanel key={instrument} instrument={instrument} />
        <RecentTrades key={instrument} instrument={instrument} />
      </div>
    </div>
  );
}

export default function OrderBookPage() {
  return (
    <Suspense>
      <Market />
    </Suspense>
  );
}
