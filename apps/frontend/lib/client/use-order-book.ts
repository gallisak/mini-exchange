'use client';

import { useEffect, useReducer } from 'react';
import { BookState, Delta, Snapshot, bookReducer, initialBook, needsSnapshot } from '../book/reducer';
import { useSocket } from './socket';

const TICK_MS = 1_000;

export function useOrderBook(instrument: string): BookState {
  const socket = useSocket();
  const [state, dispatch] = useReducer(bookReducer, instrument, (name) => initialBook(name, Date.now()));

  useEffect(() => {
    if (!socket) return;
    const subscribe = () => {
      dispatch({ type: 'connected', at: Date.now() });
      socket.emit('subscribe', instrument);
    };
    const onSnapshot = (snapshot: Snapshot) =>
      dispatch({ type: 'snapshot', snapshot, at: Date.now() });
    const onDelta = (delta: Delta) => dispatch({ type: 'delta', delta, at: Date.now() });
    const onHeartbeat = (heartbeat: { instrument: string; seq: number }) => {
      if (heartbeat.instrument === instrument) {
        dispatch({ type: 'heartbeat', seq: heartbeat.seq, at: Date.now() });
      }
    };
    const onDisconnect = () => dispatch({ type: 'disconnected' });
    const retries: ReturnType<typeof setTimeout>[] = [];
    const onRateLimited = ({ retryAfterMs }: { retryAfterMs: number }) => {
      retries.push(setTimeout(() => socket.emit('subscribe', instrument), retryAfterMs));
    };

    socket.on('connect', subscribe);
    socket.on('book_snapshot', onSnapshot);
    socket.on('book_delta', onDelta);
    socket.on('book_heartbeat', onHeartbeat);
    socket.on('disconnect', onDisconnect);
    socket.on('rate_limited', onRateLimited);
    if (socket.connected) subscribe();
    const ticker = setInterval(() => dispatch({ type: 'tick', at: Date.now() }), TICK_MS);

    return () => {
      clearInterval(ticker);
      retries.forEach(clearTimeout);
      socket.off('rate_limited', onRateLimited);
      socket.off('connect', subscribe);
      socket.off('book_snapshot', onSnapshot);
      socket.off('book_delta', onDelta);
      socket.off('book_heartbeat', onHeartbeat);
      socket.off('disconnect', onDisconnect);
      socket.emit('unsubscribe', instrument);
    };
  }, [socket, instrument]);

  useEffect(() => {
    if (!socket?.connected || !needsSnapshot(state)) return;
    dispatch({ type: 'snapshotRequested', at: Date.now() });
    socket.emit('subscribe', instrument);
  }, [socket, state, instrument]);

  return state;
}
