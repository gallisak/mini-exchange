import { ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrdersService } from '../src/orders/orders.service';
import { Order } from '../src/orders/entities/order.entity';
import { CommandStreamService } from '../src/orders/engine/command-stream.service';
import { OrderCommand } from '../src/orders/engine/order-command';
import { RedisService } from '../src/redis/redis.service';

function serviceWithRecordedCommands() {
  const appended: { instrument: string; command: OrderCommand }[] = [];
  const commands = {
    append: async (instrument: string, command: OrderCommand) => {
      appended.push({ instrument, command });
      return `${appended.length}-0`;
    },
  } as unknown as CommandStreamService;
  const records = new Map<string, string>();
  const redis = {
    isReady: () => true,
    client: {
      set: async (key: string, value: string) => {
        if (records.has(key)) return null;
        records.set(key, value);
        return 'OK';
      },
      get: async (key: string) => records.get(key) ?? null,
    },
  } as unknown as RedisService;
  const service = new OrdersService(
    { findOne: async () => null } as unknown as Repository<Order>,
    commands,
    redis,
  );
  return { service, appended };
}

const order = { instrument: 'ABC', side: 'buy' as const, price: '100.5', quantity: '2' };

describe('submit order response', () => {
  it('returns only the order id and status, never trades or counterparties', async () => {
    const { service } = serviceWithRecordedCommands();

    const response = await service.submitOrder(order, 'buyer-id', 'key-1');

    expect(Object.keys(response).sort()).toEqual(['orderId', 'status']);
    expect(response.status).toBe('accepted');
  });

  it('queues the command with normalised price and quantity', async () => {
    const { service, appended } = serviceWithRecordedCommands();

    const { orderId } = await service.submitOrder(order, 'buyer-id', 'key-1');

    expect(appended).toEqual([
      {
        instrument: 'ABC',
        command: {
          type: 'submit',
          orderId,
          ownerId: 'buyer-id',
          side: 'buy',
          price: '100.50',
          quantity: '2.00000000',
        },
      },
    ]);
  });

  it('gives a retry with the same key the same order id, scoped to the user', async () => {
    const { service } = serviceWithRecordedCommands();

    const first = await service.submitOrder(order, 'user-a', 'key-1');
    const retry = await service.submitOrder(order, 'user-a', 'key-1');
    const otherUser = await service.submitOrder(order, 'user-b', 'key-1');

    expect(retry.orderId).toBe(first.orderId);
    expect(otherUser.orderId).not.toBe(first.orderId);
  });

  it('answers 503 instead of waiting forever when Redis never answers the idempotency check', async () => {
    const never = () => new Promise(() => undefined);
    const claimHangs = new OrdersService(
      { findOne: async () => null } as unknown as Repository<Order>,
      { append: async () => '1-0' } as unknown as CommandStreamService,
      { isReady: () => true, client: { set: never, get: never } } as unknown as RedisService,
    );
    const lookupHangs = new OrdersService(
      { findOne: async () => null } as unknown as Repository<Order>,
      { append: async () => '1-0' } as unknown as CommandStreamService,
      { isReady: () => true, client: { set: async () => null, get: never } } as unknown as RedisService,
    );

    await expect(claimHangs.submitOrder(order, 'user-a', 'key-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(lookupHangs.submitOrder(order, 'user-a', 'key-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  }, 10_000);
});
