'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ApiError, api } from '@/lib/client/api';
import {
  Attempt,
  afterFailure,
  attemptFor,
  loadAttempt,
  saveAttempt,
  unconfirmed,
} from '@/lib/client/order-attempt';
import { useSession } from '@/lib/client/session';
import { cn } from '@/lib/utils';

const PRICE = /^\d{1,16}(\.\d{1,2})?$/;
const QUANTITY = /^\d{1,10}(\.\d{1,8})?$/;
const positive = (value: string) => /[1-9]/.test(value);
const sessionStore = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export function OrderForm({ instrument }: { instrument: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const owner = useSession().user?.id ?? null;
  const scope = owner && `${owner}:${instrument}`;
  const [restored, setRestored] = useState<string | null>(null);

  useEffect(() => {
    setAttempt(owner ? loadAttempt(sessionStore(), owner, instrument) : null);
    setRestored(scope);
  }, [owner, instrument, scope]);

  useEffect(() => {
    if (owner && scope && restored === scope) saveAttempt(sessionStore(), owner, instrument, attempt);
  }, [attempt, restored, scope, owner, instrument]);

  const priceError =
    price && !(PRICE.test(price) && positive(price)) ? 'Up to 2 decimals, above zero' : null;
  const quantityError =
    quantity && !(QUANTITY.test(quantity) && positive(quantity))
      ? 'Up to 8 decimals, above zero'
      : null;
  const pending =
    !busy && attempt?.unconfirmed && attempt.draft.instrument === instrument ? attempt.draft : null;
  const ready = pending || (price && quantity && !priceError && !quantityError);
  const describe = (order: Attempt['draft']) =>
    `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.quantity} ${order.instrument} @ ${order.price}`;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const current = attemptFor(attempt, { instrument, side, price, quantity }, () => crypto.randomUUID());
    const sentBy = owner;
    const settle = (next: Attempt | null) => {
      if (sentBy) saveAttempt(sessionStore(), sentBy, current.draft.instrument, next);
      setAttempt(next);
    };
    settle(unconfirmed(current));
    setBusy(true);
    try {
      await api('/api/orders', {
        method: 'POST',
        headers: { 'idempotency-key': current.key },
        body: JSON.stringify(current.draft),
      });
      toast.success(`${describe(current.draft)} accepted`);
      settle(null);
      setQuantity('');
    } catch (failure) {
      settle(afterFailure(current, failure instanceof ApiError ? failure.status : 0));
      toast.error((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const edit = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setter(event.target.value.trim());
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Place a limit order</CardTitle>
        <CardDescription>Orders are queued and matched in the order they arrive.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {pending && (
            <Alert>
              <AlertDescription className="space-y-2">
                <p>
                  {describe(pending)} may have been placed. Send it again to find out: it will not be
                  placed twice. Discard it only after checking your open orders.
                </p>
                <Button type="button" variant="outline" size="sm" onClick={() => setAttempt(null)}>
                  Discard
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <Tabs
            value={pending ? pending.side : side}
            onValueChange={(value) => setSide(value as 'buy' | 'sell')}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="buy" disabled={Boolean(pending)} className="data-[state=active]:text-buy">
                Buy
              </TabsTrigger>
              <TabsTrigger value="sell" disabled={Boolean(pending)} className="data-[state=active]:text-sell">
                Sell
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="space-y-2">
            <Label htmlFor="price">Price (USD)</Label>
            <Input
              id="price"
              inputMode="decimal"
              placeholder="100.00"
              value={pending ? pending.price : price}
              onChange={edit(setPrice)}
              disabled={Boolean(pending)}
              aria-invalid={Boolean(priceError)}
            />
            {priceError && <p className="text-xs text-destructive">{priceError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity ({instrument})</Label>
            <Input
              id="quantity"
              inputMode="decimal"
              placeholder="1.5"
              value={pending ? pending.quantity : quantity}
              onChange={edit(setQuantity)}
              disabled={Boolean(pending)}
              aria-invalid={Boolean(quantityError)}
            />
            {quantityError && <p className="text-xs text-destructive">{quantityError}</p>}
          </div>
          <Button
            type="submit"
            disabled={!ready || busy}
            className={cn(
              'w-full',
              (pending?.side ?? side) === 'buy' ? 'bg-buy hover:bg-buy/90' : 'bg-sell hover:bg-sell/90',
              'text-white',
            )}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {pending ? 'Send the same order again' : `${side === 'buy' ? 'Buy' : 'Sell'} ${instrument}`}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
