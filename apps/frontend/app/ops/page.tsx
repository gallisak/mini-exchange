'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { ErrorState, LoadingRows } from '@/components/states';
import { RequireSession } from '@/components/require-session';
import { api } from '@/lib/client/api';
import { formatTime } from '@/lib/client/format';
import {
  OPS_TIMEOUT_MS,
  RECONCILE_REFRESH_MS,
  RECONCILE_TIMEOUT_MS,
  STATUS_REFRESH_MS,
  opsView,
  startOpsPolling,
} from '@/lib/client/ops-polling';
import { singleFlight } from '@/lib/client/latest';

interface Part<T> {
  ok: boolean;
  data?: T;
  status?: number;
  error?: { message?: string };
}

interface EngineStatus {
  instance: string;
  outboxPending: number;
  instruments: {
    instrument: string;
    owner: string | null;
    ownedHere: boolean;
    fence: string;
    bookSeq: number;
    commandStreamLength: number;
    commandsBehind: number;
    stuck: { since: string; failures: number; error: string } | null;
  }[];
}

interface SettlementStatus {
  group: string;
  deadLetters: number;
  streams: {
    stream: string;
    length: number;
    pending: number;
    lag: number | null;
    consumers: number;
    retrying: number;
    oldestPendingMs: number | null;
  }[];
}

interface Reconciliation {
  status: 'ok' | 'mismatch' | 'incomplete';
  period: { from: string; to: string };
  engineError?: string;
  endedEarly?: string;
  unresolved?: { from: string; to: string; status: string }[];
  unresolvedTotal?: number;
  recheckError?: string;
  instruments: {
    instrument: string;
    engine: { count: number; notional: string } | null;
    ledger: { count: number; notional: string; cashMoved: string };
    matches: boolean;
  }[];
  ledger: Record<string, unknown[]>;
  assetsNotBalanced?: { asset: string; total: string }[];
  ledgerTotalsError?: string;
}

interface OpsReport {
  engine: Part<EngineStatus>;
  settlement: Part<SettlementStatus>;
}


const formatMoment = (iso: string) => new Date(iso).toLocaleString([], { hour12: false });

function Unavailable({ part }: { part: Part<unknown> }) {
  return <ErrorState message={part.error?.message ?? `Unavailable (${part.status})`} />;
}

function Ops() {
  const [report, setReport] = useState<OpsReport | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useMemo(
    () =>
      singleFlight(async () => {
        try {
          setReport(await api<OpsReport>('/api/ops', { timeoutMs: OPS_TIMEOUT_MS }));
          setError(null);
        } catch (failure) {
          setError((failure as Error).message);
        }
      }),
    [],
  );

  const reconcile = useMemo(
    () =>
      singleFlight(async () => {
        try {
          setReconciliation(await api<Reconciliation>('/api/ops/reconciliation', { timeoutMs: RECONCILE_TIMEOUT_MS }));
          setReconcileError(null);
        } catch (failure) {
          setReconcileError((failure as Error).message);
        }
      }),
    [],
  );

  const refresh = useCallback(() => {
    void load();
    void reconcile();
  }, [load, reconcile]);

  useEffect(
    () =>
      startOpsPolling(
        () => void load(),
        () => void reconcile(),
      ),
    [load, reconcile],
  );

  const view = opsView(report, error);
  if (view.kind === 'error') return <ErrorState message={view.message} onRetry={load} />;
  if (view.kind === 'loading') return <LoadingRows rows={8} />;
  const { engine, settlement } = view.report;
  const reconciled = opsView(reconciliation, reconcileError);
  const issues = reconciliation
    ? Object.entries(reconciliation.ledger).filter(([, rows]) => rows.length > 0)
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
          <p className="text-sm text-muted-foreground">
            Instrument ownership and the order and settlement queues refresh every{' '}
            {STATUS_REFRESH_MS / 1000} s, reconciliation every {RECONCILE_REFRESH_MS / 1000} s.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {view.staleBecause && (
        <div data-testid="ops-stale">
          <ErrorState message={`Showing the last data that loaded: ${view.staleBecause}`} onRetry={load} />
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Order books</CardTitle>
          <CardDescription>
            {engine.data
              ? `Answered by ${engine.data.instance} · outbox waiting: ${engine.data.outboxPending}`
              : 'Matching engine'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!engine.ok || !engine.data ? (
            <Unavailable part={engine} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instrument</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Fence</TableHead>
                  <TableHead className="text-right">Book seq</TableHead>
                  <TableHead className="text-right">Commands</TableHead>
                  <TableHead className="text-right">Behind</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {engine.data.instruments.map((row) => (
                  <TableRow key={row.instrument}>
                    <TableCell className="font-medium">{row.instrument}</TableCell>
                    <TableCell className="max-w-[260px] truncate font-mono text-xs">
                      {row.owner ?? <Badge variant="destructive">no owner</Badge>}
                    </TableCell>
                    <TableCell className="text-right font-mono">{row.fence}</TableCell>
                    <TableCell className="text-right font-mono">{row.bookSeq}</TableCell>
                    <TableCell className="text-right font-mono">{row.commandStreamLength}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={row.commandsBehind > 0 ? 'destructive' : 'secondary'}>
                        {row.commandsBehind}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row.stuck ? (
                        <Badge variant="destructive" title={row.stuck.error} data-testid="book-stuck">
                          stuck since {formatTime(row.stuck.since)}, {row.stuck.failures} failed batches
                        </Badge>
                      ) : (
                        <Badge variant="secondary">ok</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Settlement queue</CardTitle>
            <CardDescription>
              {settlement.data
                ? `Consumer group ${settlement.data.group} · dead letters: ${settlement.data.deadLetters}`
                : 'Settlement service'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!settlement.ok || !settlement.data ? (
              <Unavailable part={settlement} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stream</TableHead>
                    <TableHead className="text-right">Events</TableHead>
                    <TableHead className="text-right">Lag</TableHead>
                    <TableHead className="text-right">Pending</TableHead>
                    <TableHead className="text-right">Consumers</TableHead>
                    <TableHead className="text-right">Retrying</TableHead>
                    <TableHead className="text-right">Oldest</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settlement.data.streams.map((row) => (
                    <TableRow key={row.stream}>
                      <TableCell className="font-mono text-xs">{row.stream}</TableCell>
                      <TableCell className="text-right font-mono">{row.length}</TableCell>
                      <TableCell className="text-right font-mono">{row.lag ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={row.pending > 0 ? 'destructive' : 'secondary'}>
                          {row.pending}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">{row.consumers}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant={row.retrying > 0 ? 'destructive' : 'secondary'}>
                          {row.retrying}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {row.oldestPendingMs === null ? '—' : `${Math.round(row.oldestPendingMs / 1000)} s`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
            <div className="space-y-1">
              <CardTitle className="text-base">Reconciliation</CardTitle>
              <CardDescription>Engine trades against ledger postings</CardDescription>
            </div>
            {reconciliation && (
              <Badge
                variant={reconciliation.status === 'ok' ? 'secondary' : 'destructive'}
                className="gap-1"
                data-testid="reconciliation-status"
              >
                {reconciliation.status === 'ok' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {reconciliation.status}
              </Badge>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {reconciled.kind === 'loading' ? (
              <LoadingRows rows={3} />
            ) : reconciled.kind === 'error' ? (
              <ErrorState message={reconciled.message} />
            ) : (
              <>
                {reconciled.staleBecause && (
                  <div data-testid="reconciliation-stale">
                    <ErrorState message={`Showing the last result: ${reconciled.staleBecause}`} />
                  </div>
                )}
                {reconciled.report.engineError && (
                  <ErrorState message={reconciled.report.engineError} />
                )}
                {reconciled.report.recheckError && (
                  <ErrorState message={reconciled.report.recheckError} />
                )}
                {reconciled.report.ledgerTotalsError && (
                  <ErrorState message={reconciled.report.ledgerTotalsError} />
                )}
                {(reconciled.report.assetsNotBalanced ?? []).length > 0 && (
                  <ErrorState
                    message={`The whole ledger does not add up to zero: ${(reconciled.report.assetsNotBalanced ?? [])
                      .map((row) => `${row.asset} ${row.total}`)
                      .join(', ')}`}
                  />
                )}
                {reconciled.report.endedEarly && (
                  <p className="text-xs text-muted-foreground">
                    Checked up to {formatMoment(reconciled.report.period.to)}: {reconciled.report.endedEarly}.
                  </p>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Instrument</TableHead>
                      <TableHead className="text-right">Trades</TableHead>
                      <TableHead className="text-right">Notional</TableHead>
                      <TableHead className="text-right">USD moved</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconciled.report.instruments.map((row) => (
                      <TableRow key={row.instrument}>
                        <TableCell className="font-medium">{row.instrument}</TableCell>
                        <TableCell className="text-right font-mono">
                          {row.engine?.count ?? '—'} / {row.ledger.count}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {row.engine?.notional ?? '—'}
                        </TableCell>
                        <TableCell className="text-right font-mono">{row.ledger.cashMoved}</TableCell>
                        <TableCell>
                          {row.matches ? (
                            <CheckCircle2 className="h-4 w-4 text-buy" />
                          ) : (
                            <XCircle className="h-4 w-4 text-sell" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {issues.length > 0 && (
                  <ErrorState
                    message={issues.map(([check, rows]) => `${check}: ${rows.length}`).join(' · ')}
                  />
                )}
                {(reconciled.report.unresolved ?? []).length > 0 && (
                  <ErrorState
                    message={`Earlier periods that still do not match (${reconciled.report.unresolvedTotal ?? reconciled.report.unresolved?.length}): ${(reconciled.report.unresolved ?? [])
                      .map((period) => `${formatMoment(period.from)} – ${formatMoment(period.to)}`)
                      .join(', ')}`}
                  />
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function OpsPage() {
  return <RequireSession admin>{() => <Ops />}</RequireSession>;
}
