import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MarketEvent, marketChannel } from './market-events';

const RESYNC_RETRY_MS = 1000;
const RESYNC_CHANNEL = marketChannel('resync');

@Injectable()
export class MarketPublisherService implements OnModuleDestroy {
  private readonly logger = new Logger(MarketPublisherService.name);
  private readonly lost = { instruments: new Set<string>(), owners: new Set<string>() };
  private retry?: NodeJS.Timeout;

  constructor(private readonly redis: RedisService) {}

  onModuleDestroy(): void {
    clearTimeout(this.retry);
    this.retry = undefined;
  }

  async publish(instrument: string, event: MarketEvent): Promise<void> {
    try {
      await this.redis.client.publish(marketChannel(instrument), JSON.stringify(event));
    } catch (error) {
      this.remember(instrument, event);
      this.logger.warn(
        `Could not publish ${event.type} for ${instrument}, its subscribers will resync: ${(error as Error).message}`,
      );
      return;
    }
    await this.announceLost();
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
    this.retry ??= setTimeout(() => {
      this.retry = undefined;
      void this.announceLost();
    }, RESYNC_RETRY_MS);
  }

  private async announceLost(): Promise<void> {
    if (this.lost.instruments.size === 0 && this.lost.owners.size === 0) return;
    const event: MarketEvent = {
      type: 'resync',
      resync: { instruments: [...this.lost.instruments], owners: [...this.lost.owners] },
    };
    this.lost.instruments.clear();
    this.lost.owners.clear();
    await this.redis.client
      .publish(RESYNC_CHANNEL, JSON.stringify(event))
      .catch(() => this.remember('', event));
  }
}
