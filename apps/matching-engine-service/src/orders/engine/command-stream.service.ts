import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { withTimeout } from '../../common/with-timeout';
import { OrderCommand, commandStreamKey, encodeCommand } from './order-command';

const APPEND_TIMEOUT_MS = 2_000;

@Injectable()
export class CommandStreamService {
  constructor(private readonly redis: RedisService) {}

  async append(instrument: string, command: OrderCommand): Promise<string> {
    const id = await withTimeout(
      this.redis.client.xadd(commandStreamKey(instrument), '*', ...encodeCommand(command)),
      APPEND_TIMEOUT_MS,
      'Redis',
    ).catch(() => {
      throw new ServiceUnavailableException('The order queue did not answer, send the order again');
    });
    return id as string;
  }
}
