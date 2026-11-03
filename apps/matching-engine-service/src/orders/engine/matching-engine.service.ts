import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from '../../redis/redis.service';
import { OrderBookService } from '../order-book.service';
import { BookRunner } from './book-runner';

@Injectable()
export class MatchingEngineService implements OnModuleDestroy {
  private readonly runners = new Map<string, BookRunner>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly orderBook: OrderBookService,
  ) {}

  isRunning(instrument: string): boolean {
    return this.runners.has(instrument);
  }

  async startInstrument(instrument: string): Promise<void> {
    if (this.runners.has(instrument)) return;
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

  async stopInstrument(instrument: string): Promise<void> {
    const runner = this.runners.get(instrument);
    if (!runner) return;
    this.runners.delete(instrument);
    await runner.stop();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((instrument) => this.stopInstrument(instrument)));
  }
}
