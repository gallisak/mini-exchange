'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { mergeOrders } from './feeds';
import { useSocket } from './socket';
import { Order } from './types';

export function useOrders() {
  const socket = useSocket();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const fresh = await api<Order[]>('/api/orders');
      setOrders((current) => mergeOrders(current ?? [], fresh));
      loaded.current = true;
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, []);

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
    socket.on('order', onOrder);
    socket.on('connect', onConnect);
    return () => {
      socket.off('order', onOrder);
      socket.off('connect', onConnect);
    };
  }, [socket, load]);

  return { orders, error, reload: load };
}
