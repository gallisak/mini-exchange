import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { withTimeout } from '../../common/with-timeout';
import { OrderCommand, commandStreamKey, encodeCommand } from './order-command';

const APPEND_TIMEOUT_MS = 2_000;
const ACCEPTED_TTL_SECONDS = 24 * 60 * 60;

export function acceptedOrderKey(ownerId: string, orderId: string): string {
  return `orders:accepted:${ownerId}:${orderId}`;
}

@Injectable()
export class CommandStreamService {
  constructor(private readonly redis: RedisService) {}

  async append(instrument: string, command: OrderCommand): Promise<string> {
    const stream = commandStreamKey(instrument);
    const written =
      command.type === 'submit'
        ? this.redis.client
            .multi()
            .set(acceptedOrderKey(command.ownerId, command.orderId), instrument, 'EX', ACCEPTED_TTL_SECONDS)
            .xadd(stream, '*', ...encodeCommand(command))
            .exec()
            .then((replies) => {
              if (!replies || replies.some(([error]) => error)) throw new Error('The order queue refused the order');
              return replies[1][1];
            })
        : this.redis.client.xadd(stream, '*', ...encodeCommand(command));
    const id = await withTimeout(written, APPEND_TIMEOUT_MS, 'Redis').catch(() => {
      throw new ServiceUnavailableException('The order queue did not answer, send the order again');
    });
    return id as string;
  }

  acceptedInstrument(ownerId: string, orderId: string): Promise<string | null> {
    return withTimeout(this.redis.client.get(acceptedOrderKey(ownerId, orderId)), APPEND_TIMEOUT_MS, 'Redis').catch(() => {
      throw new ServiceUnavailableException('The order queue did not answer, try again');
    });
  }
}
