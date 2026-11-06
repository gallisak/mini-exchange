'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { mergeOrders } from './feeds';
import { latestRequest } from './latest';
import { useSocket } from './socket';
import { Order, ResyncScope, resyncsOrders } from './types';

export function useOrders() {
  const socket = useSocket();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  const begin = useMemo(() => latestRequest(), []);

  const load = useCallback(async () => {
    const turn = begin();
    try {
      const fresh = await api<Order[]>('/api/orders');
      if (turn.show()) {
        setOrders((current) => mergeOrders(current ?? [], fresh));
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

  return { orders, error, reload: load };
}
