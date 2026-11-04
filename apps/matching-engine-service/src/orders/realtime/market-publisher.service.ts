import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MarketEvent, marketChannel } from './market-events';

@Injectable()
export class MarketPublisherService {
  private readonly logger = new Logger(MarketPublisherService.name);

  constructor(private readonly redis: RedisService) {}

  async publish(instrument: string, event: MarketEvent): Promise<void> {
    try {
      await this.redis.client.publish(marketChannel(instrument), JSON.stringify(event));
    } catch (error) {
      this.logger.warn(
        `Could not publish ${event.type} for ${instrument}, subscribers will resync: ${(error as Error).message}`,
      );
    }
  }
}
