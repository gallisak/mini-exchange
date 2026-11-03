import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { INSTRUMENTS } from '../../common/instruments';
import { RedisLockService } from '../../locks/redis-lock.service';
import { MatchingEngineService } from './matching-engine.service';

export function instrumentLockKey(instrument: string): string {
  return `lock:instrument:${instrument}`;
}

@Injectable()
export class InstrumentOwnershipService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InstrumentOwnershipService.name);
  private readonly ownerId = process.env.INSTANCE_ID ?? 'engine';
  private readonly acquireIntervalMs = Number(process.env.LOCK_ACQUIRE_INTERVAL_MS ?? 1000);
  private readonly owned = new Set<string>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly lock: RedisLockService,
    private readonly engine: MatchingEngineService,
  ) {}

  ownedInstruments(): string[] {
    return [...this.owned];
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.acquireIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const instrument of this.owned) {
      await this.engine.stopInstrument(instrument);
      await this.lock
        .release(instrumentLockKey(instrument), this.ownerId)
        .catch((error: Error) =>
          this.logger.error(`Could not release ${instrument}: ${error.message}`),
        );
    }
    this.owned.clear();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const instrument of INSTRUMENTS) {
        if (this.stopped) return;
        if (this.owned.has(instrument)) continue;
        if (await this.lock.acquire(instrumentLockKey(instrument), this.ownerId)) {
          this.owned.add(instrument);
          await this.engine.startInstrument(instrument);
          this.logger.log(`${this.ownerId} owns ${instrument}`);
        }
      }
    } catch (error) {
      this.logger.error(`Ownership check failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
