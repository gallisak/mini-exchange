import { Level } from '@/lib/book/reducer';
import { subtractDecimals } from '@/lib/client/decimal';
import { trimAmount } from '@/lib/client/format';
import { cn } from '@/lib/utils';

const DEPTH = 12;

function Row({ level, side, max }: { level: Level; side: 'buy' | 'sell'; max: number }) {
  const share = max > 0 ? (Number(level.quantity) / max) * 100 : 0;
  return (
    <div className="relative grid grid-cols-3 px-3 py-1 font-mono text-sm tabular-nums">
      <div
        className={cn('absolute inset-y-0 right-0', side === 'buy' ? 'bg-buy/10' : 'bg-sell/10')}
        style={{ width: `${share}%` }}
      />
      <span className={cn('relative', side === 'buy' ? 'text-buy' : 'text-sell')}>
        {level.price}
      </span>
      <span className="relative text-right">{trimAmount(level.quantity, 2)}</span>
      <span className="relative text-right text-muted-foreground">{level.orders}</span>
    </div>
  );
}

export function OrderBookTable({ bids, asks }: { bids: Level[]; asks: Level[] }) {
  const shownAsks = asks.slice(0, DEPTH).reverse();
  const shownBids = bids.slice(0, DEPTH);
  const max = Math.max(0, ...[...shownAsks, ...shownBids].map((level) => Number(level.quantity)));
  const spread = asks[0] && bids[0] ? subtractDecimals(asks[0].price, bids[0].price) : null;

  return (
    <div>
      <div className="grid grid-cols-3 px-3 pb-2 text-xs font-medium uppercase text-muted-foreground">
        <span>Price</span>
        <span className="text-right">Quantity</span>
        <span className="text-right">Orders</span>
      </div>
      <div className="min-h-[120px]" data-testid="asks">
        {shownAsks.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">No asks</p>
        ) : (
          shownAsks.map((level) => <Row key={level.price} level={level} side="sell" max={max} />)
        )}
      </div>
      <div className="my-1 border-y bg-muted/40 px-3 py-1.5 text-center text-xs text-muted-foreground">
        {spread === null ? 'No spread' : `Spread ${spread}`}
      </div>
      <div className="min-h-[120px]" data-testid="bids">
        {shownBids.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">No bids</p>
        ) : (
          shownBids.map((level) => <Row key={level.price} level={level} side="buy" max={max} />)
        )}
      </div>
    </div>
  );
}
