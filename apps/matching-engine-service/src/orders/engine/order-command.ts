import { OrderSide } from '../entities/order.entity';

export type OrderCommand =
  | {
      type: 'submit';
      orderId: string;
      ownerId: string;
      side: OrderSide;
      price: string;
      quantity: string;
    }
  | {
      type: 'cancel';
      orderId: string;
      ownerId: string;
    };

export interface StreamCommand {
  id: string;
  command: OrderCommand | null;
}

const FIELD = 'command';

export function commandStreamKey(instrument: string): string {
  return `orders:commands:${instrument}`;
}

export function encodeCommand(command: OrderCommand): [string, string] {
  return [FIELD, JSON.stringify(command)];
}

export function decodeCommand(fields: string[]): OrderCommand | null {
  const index = fields.indexOf(FIELD);
  if (index < 0 || index + 1 >= fields.length) return null;
  try {
    return JSON.parse(fields[index + 1]) as OrderCommand;
  } catch {
    return null;
  }
}

export function streamTimestamp(streamId: string): Date {
  return new Date(Number(streamId.split('-')[0]));
}
