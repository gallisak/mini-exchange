import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MarketEvent, marketChannel } from './market-events';

@Injectable()
export class MarketPublisherService {
  private readonly logger = new Logger(MarketPublisherService.name);
  private readonly lost = { instruments: new Set<string>(), owners: new Set<string>() };

  constructor(private readonly redis: RedisService) {}

  async publish(instrument: string, event: MarketEvent): Promise<void> {
    const channel = marketChannel(instrument);
    try {
      await this.redis.client.publish(channel, JSON.stringify(event));
    } catch (error) {
      this.remember(instrument, event);
      this.logger.warn(
        `Could not publish ${event.type} for ${instrument}, its subscribers will resync: ${(error as Error).message}`,
      );
      return;
    }
    await this.announceLost(channel);
  }

  private remember(instrument: string, event: MarketEvent): void {
    if (event.type === 'orders') {
      for (const order of event.orders) this.lost.owners.add(order.ownerId);
    } else if (event.type === 'resync') {
      event.resync.instruments.forEach((name) => this.lost.instruments.add(name));
      event.resync.owners.forEach((owner) => this.lost.owners.add(owner));
    } else {
      this.lost.instruments.add(instrument);
    }
  }

  private async announceLost(channel: string): Promise<void> {
    if (this.lost.instruments.size === 0 && this.lost.owners.size === 0) return;
    const event: MarketEvent = {
      type: 'resync',
      resync: { instruments: [...this.lost.instruments], owners: [...this.lost.owners] },
    };
    this.lost.instruments.clear();
    this.lost.owners.clear();
    await this.redis.client.publish(channel, JSON.stringify(event)).catch(() => this.remember('', event));
  }
}
