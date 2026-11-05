'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { mergeTrades, newestSeq, skipsTrades } from './feeds';
import { useSocket } from './socket';
import { Trade } from './types';

const KEEP = 50;

export function useTrades(instrument: string) {
  const socket = useSocket();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const arrived = useRef<Trade[]>([]);
  const newest = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await api<Trade[]>(`/api/market/trades?instrument=${instrument}`);
      const meanwhile = arrived.current;
      arrived.current = [];
      loaded.current = true;
      newest.current = Math.max(newest.current ?? 0, newestSeq([...fresh, ...meanwhile]) ?? 0);
      setTrades((current) => mergeTrades(current ?? [], [...fresh, ...meanwhile], KEEP));
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [instrument]);

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
    socket.on('trade', onTrade);
    socket.on('connect', onConnect);
    return () => {
      socket.off('trade', onTrade);
      socket.off('connect', onConnect);
    };
  }, [socket, instrument, load]);

  return { trades, error, reload: load };
}
