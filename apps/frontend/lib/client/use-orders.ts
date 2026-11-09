'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { HistoryCursor, mergeOrders, oldestFinished } from './feeds';
import { latestRequest } from './latest';
import { useSocket } from './socket';
import { Order, ResyncScope, resyncsOrders } from './types';

export function useOrders() {
  const socket = useSocket();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const [olderDone, setOlderDone] = useState(false);
  const [cursor, setCursor] = useState<HistoryCursor | null>(null);
  const begin = useMemo(() => latestRequest(), []);

  const load = useCallback(async () => {
    const turn = begin();
    try {
      const fresh = await api<Order[]>('/api/orders');
      if (turn.show()) {
        setOrders((current) => mergeOrders(current ?? [], fresh));
        setCursor((current) => oldestFinished(fresh, current));
        loaded.current = true;
      }
      if (turn.latest()) setError(null);
    } catch (failure) {
      if (turn.latest()) setError((failure as Error).message);
    }
  }, [begin]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return;
    const onOrder = (order: Order) => {
      if (!loaded.current) {
        void load();
        return;
      }
      setOrders((current) => (current ? mergeOrders(current, [order]) : current));
    };
    const onConnect = () => void load();
    const onResync = (scope?: ResyncScope) => {
      if (resyncsOrders(scope)) void load();
    };
    socket.on('order', onOrder);
    socket.on('connect', onConnect);
    socket.on('resync', onResync);
    return () => {
      socket.off('order', onOrder);
      socket.off('connect', onConnect);
      socket.off('resync', onResync);
    };
  }, [socket, load]);

  const loadOlder = useCallback(async () => {
    if (!cursor) return;
    const query = new URLSearchParams({ before: cursor.createdAt, beforeId: cursor.id });
    const older = await api<Order[]>(`/api/orders/history?${query}`);
    setOrders((current) => mergeOrders(current ?? [], older));
    setCursor((current) => oldestFinished(older, current));
    if (older.length === 0) setOlderDone(true);
  }, [cursor]);

  return { orders, error, reload: load, loadOlder, olderDone: olderDone || cursor === null };
}
