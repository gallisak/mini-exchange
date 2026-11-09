'use client';

import { Suspense } from 'react';
import { InstrumentSelect, useInstrument } from '@/components/instrument-select';
import { OrderForm } from '@/components/orders/order-form';
import { OrdersTable } from '@/components/orders/orders-table';
import { RequireSession } from '@/components/require-session';
import { useOrders } from '@/lib/client/use-orders';

function Orders() {
  const instrument = useInstrument();
  const { orders, error, reload, loadOlder, olderDone } = useOrders();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">
            Place limit orders and follow them as they fill, live.
          </p>
        </div>
        <InstrumentSelect />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <OrderForm key={instrument} instrument={instrument} />
        <OrdersTable orders={orders} error={error} reload={reload} loadOlder={loadOlder} olderDone={olderDone} />
      </div>
    </div>
  );
}

export default function OrdersPage() {
  return (
    <Suspense>
      <RequireSession>{() => <Orders />}</RequireSession>
    </Suspense>
  );
}
