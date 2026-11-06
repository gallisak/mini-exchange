'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { mergeTrades, newestSeq, skipsTrades } from './feeds';
import { latestRequest } from './latest';
import { useSocket } from './socket';
import { ResyncScope, Trade, resyncsBook } from './types';

const KEEP = 50;

export function useTrades(instrument: string) {
  const socket = useSocket();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const arrived = useRef<Trade[]>([]);
  const newest = useRef<number | null>(null);
  const begin = useMemo(() => latestRequest(), []);

  const load = useCallback(async () => {
    const turn = begin();
    try {
      const fresh = await api<Trade[]>(`/api/market/trades?instrument=${instrument}`);
      const meanwhile = arrived.current;
      arrived.current = [];
      loaded.current = true;
      newest.current = Math.max(newest.current ?? 0, newestSeq([...fresh, ...meanwhile]) ?? 0);
      setTrades((current) => mergeTrades(current ?? [], [...fresh, ...meanwhile], KEEP));
      if (turn.latest()) setError(null);
    } catch (failure) {
      if (turn.latest()) setError((failure as Error).message);
    }
  }, [instrument, begin]);

  useEffect(() => {
    loaded.current = false;
    arrived.current = [];
    newest.current = null;
    setTrades(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onTrade = (trade: Trade) => {
      if (trade.instrument !== instrument) return;
      if (!loaded.current) {
        arrived.current.push(trade);
        return;
      }
      const skipped = skipsTrades(newest.current, trade);
      newest.current = Math.max(newest.current ?? 0, trade.seq);
      setTrades((current) => mergeTrades(current ?? [], [trade], KEEP));
      if (skipped) void load();
    };
    const onConnect = () => void load();
    const onJoined = (snapshot: { instrument?: string }) => {
      if (snapshot?.instrument === instrument) void load();
    };
    const onResync = (scope?: ResyncScope) => {
      if (resyncsBook(scope, instrument)) void load();
    };
    socket.on('trade', onTrade);
    socket.on('connect', onConnect);
    socket.on('book_snapshot', onJoined);
    socket.on('resync', onResync);
    return () => {
      socket.off('trade', onTrade);
      socket.off('connect', onConnect);
      socket.off('book_snapshot', onJoined);
      socket.off('resync', onResync);
    };
  }, [socket, instrument, load]);

  return { trades, error, reload: load };
}
