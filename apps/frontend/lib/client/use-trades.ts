'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useSocket } from './socket';
import { Trade } from './types';

const KEEP = 50;

export function useTrades(instrument: string) {
  const socket = useSocket();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrades(await api<Trade[]>(`/api/market/trades?instrument=${instrument}`));
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, [instrument]);

  useEffect(() => {
    setTrades(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onTrade = (trade: Trade) => {
      if (trade.instrument !== instrument) return;
      setTrades((current) =>
        current && !current.some((known) => known.id === trade.id)
          ? [trade, ...current].slice(0, KEEP)
          : current,
      );
    };
    const onReconnect = () => void load();
    socket.on('trade', onTrade);
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.off('trade', onTrade);
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, instrument, load]);

  return { trades, error, reload: load };
}
