'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useSocket } from './socket';
import { Order } from './types';

export function useOrders() {
  const socket = useSocket();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      setOrders(await api<Order[]>('/api/orders'));
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
      setOrders((current) => {
        if (!current) return current;
        const rest = current.filter((known) => known.id !== order.id);
        return [order, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    };
    const onReconnect = () => void load();
    socket.on('order', onOrder);
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.off('order', onOrder);
      socket.io.off('reconnect', onReconnect);
    };
  }, [socket, load]);

  return { orders, error, reload: load };
}
