import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { intEnv } from '../../common/env';
import { RedisService } from '../../redis/redis.service';
import { OrderBookService } from '../order-book.service';
import { BookRunner } from './book-runner';
import { FencedOutError } from './fenced-out.error';
import { MarketPublisherService } from '../realtime/market-publisher.service';

export interface InstrumentLease {
  fence: bigint;
  isValid: () => boolean;
  onFenced: (error: FencedOutError) => void;
}

@Injectable()
export class MatchingEngineService implements OnModuleDestroy {
  private readonly runners = new Map<string, BookRunner>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly heartbeatMs = intEnv('BOOK_HEARTBEAT_MS', 2000, 0);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly orderBook: OrderBookService,
    private readonly market: MarketPublisherService,
  ) {}

  isRunning(instrument: string): boolean {
    return this.runners.has(instrument);
  }

  isStopping(instrument: string): boolean {
    return this.stopping.has(instrument);
  }

  async startInstrument(instrument: string, lease: InstrumentLease): Promise<void> {
    const existing = this.runners.get(instrument);
    if (existing?.fence === lease.fence) return;
    if (existing) await this.stopInstrument(instrument);
    await this.stopping.get(instrument);
    const runner = new BookRunner(instrument, {
      dataSource: this.dataSource,
      redis: this.redis,
      orderBook: this.orderBook,
      batchSize: 100,
      blockMs: 1000,
      retryDelayMs: 1000,
      fence: lease.fence,
      leaseValid: lease.isValid,
      publish: (event) => this.market.publish(instrument, event),
      heartbeatMs: this.heartbeatMs,
      onFenced: (error) => {
        if (this.runners.get(instrument) === runner) this.runners.delete(instrument);
        void this.track(instrument, runner);
        lease.onFenced(error);
      },
    });
    await runner.start();
    this.runners.set(instrument, runner);
  }

  async stopInstrument(instrument: string): Promise<void> {
    const runner = this.runners.get(instrument);
    if (!runner) {
      await this.stopping.get(instrument);
      return;
    }
    this.runners.delete(instrument);
    await this.track(instrument, runner);
  }

  private track(instrument: string, runner: BookRunner): Promise<void> {
    const previous = this.stopping.get(instrument);
    const stopped: Promise<void> = Promise.all([previous, runner.stop()])
      .then(() => undefined)
      .finally(() => {
        if (this.stopping.get(instrument) === stopped) this.stopping.delete(instrument);
      });
    this.stopping.set(instrument, stopped);
    return stopped;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((instrument) => this.stopInstrument(instrument)));
    await Promise.all([...this.stopping.values()]);
  }
}
