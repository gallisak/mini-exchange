import { Badge } from '@/components/ui/badge';
import { ConnectionStatus } from '@/lib/book/reducer';
import { cn } from '@/lib/utils';

const LOOK: Record<ConnectionStatus, { label: string; dot: string; hint: string }> = {
  connecting: { label: 'connecting', dot: 'bg-muted-foreground', hint: 'Connecting to the market' },
  live: { label: 'live', dot: 'bg-buy', hint: 'Receiving every change in order' },
  reconnecting: {
    label: 'reconnecting',
    dot: 'bg-amber-500 animate-pulse',
    hint: 'Connection lost, the book shown may be out of date',
  },
  stale: {
    label: 'stale',
    dot: 'bg-sell animate-pulse',
    hint: 'An update was missed, fetching a fresh snapshot',
  },
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const look = LOOK[status];
  return (
    <Badge variant="outline" className="gap-2 font-normal" title={look.hint} data-status={status}>
      <span className={cn('h-2 w-2 rounded-full', look.dot)} />
      {look.label}
    </Badge>
  );
}
