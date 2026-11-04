import { Order } from '../entities/order.entity';
import { BookSnapshot, Trade } from '../order-book.types';
import { matchOrder } from '../matcher';
import { uuidV5 } from '../../common/uuid';
import {
  PRICE_INTEGER_DIGITS,
  PRICE_SCALE,
  QUANTITY_INTEGER_DIGITS,
  QUANTITY_SCALE,
  fromUnits,
  isPositiveDecimal,
} from '../../common/decimal';
import { OrderCommand, StreamCommand, streamTimestamp } from './order-command';

export interface EngineState {
  lastCommandId: string;
  orderSeq: bigint;
  tradeSeq: bigint;
  bookSeq: bigint;
}

export interface ExecutedTrade extends Trade {
  seq: string;
  traceId?: string | null;
}

export interface ApplyResult {
  book: BookSnapshot;
  state: EngineState;
  orders: Order[];
  trades: ExecutedTrade[];
}

const ZERO_QUANTITY = fromUnits(0n, QUANTITY_SCALE);

export function applyCommands(
  instrument: string,
  book: BookSnapshot,
  state: EngineState,
  commands: StreamCommand[],
  knownOrderIds: ReadonlySet<string>,
): ApplyResult {
  let current: BookSnapshot = { bids: [...book.bids], asks: [...book.asks] };
  let { orderSeq, tradeSeq } = state;
  const changed = new Map<string, Order>();
  const trades: ExecutedTrade[] = [];
  const seen = new Set(knownOrderIds);

  for (const { id, command } of commands) {
    if (!command) continue;

    if (command.type === 'submit') {
      if (!isValidSubmit(command) || seen.has(command.orderId)) continue;
      seen.add(command.orderId);
      orderSeq += 1n;
      const createdAt = streamTimestamp(id);
      const incoming: Order = {
        id: command.orderId,
        ownerId: command.ownerId,
        instrument,
        side: command.side,
        price: command.price,
        quantity: command.quantity,
        remainingQuantity: command.quantity,
        status: 'open',
        createdAt,
        seq: orderSeq.toString(),
      };
      let fill = 0;
      const result = matchOrder(current, incoming, {
        nextTradeId: () => uuidV5(`${command.orderId}:${fill++}`),
        now: () => createdAt,
      });
      current = { bids: result.updatedBids, asks: result.updatedAsks };
      for (const order of [result.incomingOrder, ...result.touchedOrders]) {
        changed.set(order.id, order);
      }
      for (const trade of result.trades) {
        tradeSeq += 1n;
        trades.push({ ...trade, seq: tradeSeq.toString(), traceId: command.traceId ?? null });
      }
      continue;
    }

    const resting = [...current.bids, ...current.asks].find((o) => o.id === command.orderId);
    if (!resting || resting.ownerId !== command.ownerId) continue;
    current = {
      bids: current.bids.filter((o) => o.id !== resting.id),
      asks: current.asks.filter((o) => o.id !== resting.id),
    };
    changed.set(resting.id, { ...resting, status: 'cancelled', remainingQuantity: ZERO_QUANTITY });
  }

  return {
    book: current,
    state: {
      lastCommandId: commands.length > 0 ? commands[commands.length - 1].id : state.lastCommandId,
      orderSeq,
      tradeSeq,
      bookSeq: changed.size > 0 ? state.bookSeq + 1n : state.bookSeq,
    },
    orders: [...changed.values()],
    trades,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSubmit(command: OrderCommand | null): boolean {
  return (
    command?.type === 'submit' &&
    UUID_PATTERN.test(command.orderId) &&
    typeof command.ownerId === 'string' &&
    command.ownerId.length > 0 &&
    (command.side === 'buy' || command.side === 'sell') &&
    isPositiveDecimal(command.price, PRICE_INTEGER_DIGITS, PRICE_SCALE) &&
    isPositiveDecimal(command.quantity, QUANTITY_INTEGER_DIGITS, QUANTITY_SCALE)
  );
}
