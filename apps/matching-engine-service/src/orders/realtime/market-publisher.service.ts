import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MarketEvent, marketChannel } from './market-events';

@Injectable()
export class MarketPublisherService {
  private readonly logger = new Logger(MarketPublisherService.name);
  private lostUpdates = false;

  constructor(private readonly redis: RedisService) {}

  async publish(instrument: string, event: MarketEvent): Promise<void> {
    const channel = marketChannel(instrument);
    try {
      await this.redis.client.publish(channel, JSON.stringify(event));
    } catch (error) {
      this.lostUpdates = true;
      this.logger.warn(
        `Could not publish ${event.type} for ${instrument}, subscribers will resync: ${(error as Error).message}`,
      );
      return;
    }
    if (!this.lostUpdates) return;
    this.lostUpdates = false;
    await this.redis.client.publish(channel, JSON.stringify({ type: 'resync' })).catch(() => {
      this.lostUpdates = true;
    });
  }
}
