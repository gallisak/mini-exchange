import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { OrderCommand, commandStreamKey, encodeCommand } from './order-command';

@Injectable()
export class CommandStreamService {
  constructor(private readonly redis: RedisService) {}

  async append(instrument: string, command: OrderCommand): Promise<string> {
    const id = await this.redis.client.xadd(
      commandStreamKey(instrument),
      '*',
      ...encodeCommand(command),
    );
    return id as string;
  }
}
