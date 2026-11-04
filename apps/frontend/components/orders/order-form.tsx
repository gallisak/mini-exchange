'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/utils';

const PRICE = /^\d{1,16}(\.\d{1,2})?$/;
const QUANTITY = /^\d{1,10}(\.\d{1,8})?$/;
const positive = (value: string) => /[1-9]/.test(value);

export function OrderForm({ instrument }: { instrument: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [attemptKey, setAttemptKey] = useState<string | null>(null);

  const priceError =
    price && !(PRICE.test(price) && positive(price)) ? 'Up to 2 decimals, above zero' : null;
  const quantityError =
    quantity && !(QUANTITY.test(quantity) && positive(quantity))
      ? 'Up to 8 decimals, above zero'
      : null;
  const ready = price && quantity && !priceError && !quantityError;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const key = attemptKey ?? crypto.randomUUID();
    setAttemptKey(key);
    setBusy(true);
    try {
      await api('/api/orders', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: JSON.stringify({ instrument, side, price, quantity }),
      });
      toast.success(`${side === 'buy' ? 'Buy' : 'Sell'} ${quantity} ${instrument} @ ${price} accepted`);
      setAttemptKey(null);
      setQuantity('');
    } catch (failure) {
      toast.error((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const edit = (setter: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setAttemptKey(null);
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
          <Tabs
            value={side}
            onValueChange={(value) => {
              setAttemptKey(null);
              setSide(value as 'buy' | 'sell');
            }}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="buy" className="data-[state=active]:text-buy">
                Buy
              </TabsTrigger>
              <TabsTrigger value="sell" className="data-[state=active]:text-sell">
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
              value={price}
              onChange={edit(setPrice)}
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
              value={quantity}
              onChange={edit(setQuantity)}
              aria-invalid={Boolean(quantityError)}
            />
            {quantityError && <p className="text-xs text-destructive">{quantityError}</p>}
          </div>
          <Button
            type="submit"
            disabled={!ready || busy}
            className={cn(
              'w-full',
              side === 'buy' ? 'bg-buy hover:bg-buy/90' : 'bg-sell hover:bg-sell/90',
              'text-white',
            )}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {side === 'buy' ? 'Buy' : 'Sell'} {instrument}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
