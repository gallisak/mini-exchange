import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { INSTRUMENTS } from '../../common/instruments';
import { RedisService } from '../../redis/redis.service';
import { OrderBookService } from '../order-book.service';
import { BookRunner } from './book-runner';

@Injectable()
export class MatchingEngineService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly runners = new Map<string, BookRunner>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly orderBook: OrderBookService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const instrument of INSTRUMENTS) {
      const runner = new BookRunner(instrument, {
        dataSource: this.dataSource,
        redis: this.redis,
        orderBook: this.orderBook,
        batchSize: 100,
        blockMs: 1000,
        retryDelayMs: 1000,
      });
      await runner.start();
      this.runners.set(instrument, runner);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.stop()));
    this.runners.clear();
  }
}
