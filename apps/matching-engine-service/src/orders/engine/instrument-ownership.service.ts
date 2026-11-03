import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { INSTRUMENTS } from '../../common/instruments';
import { RedisLockService } from '../../locks/redis-lock.service';
import { MatchingEngineService } from './matching-engine.service';

export function instrumentLockKey(instrument: string): string {
  return `lock:instrument:${instrument}`;
}

@Injectable()
export class InstrumentOwnershipService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InstrumentOwnershipService.name);
  private readonly ownerId = `${process.env.INSTANCE_ID ?? 'engine'}:${randomUUID()}`;
  private readonly ttlMs = Number(process.env.LOCK_TTL_MS ?? 5000);
  private readonly renewIntervalMs = Number(process.env.LOCK_RENEW_INTERVAL_MS ?? 1500);
  private readonly acquireIntervalMs = Number(process.env.LOCK_ACQUIRE_INTERVAL_MS ?? 1000);
  private readonly owned = new Set<string>();
  private acquireTimer?: NodeJS.Timeout;
  private renewTimer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly lock: RedisLockService,
    private readonly engine: MatchingEngineService,
  ) {}

  ownedInstruments(): string[] {
    return [...this.owned];
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.acquireFree();
    this.acquireTimer = setInterval(() => void this.exclusive(() => this.acquireFree()), this.acquireIntervalMs);
    this.renewTimer = setInterval(() => void this.exclusive(() => this.renewOwned()), this.renewIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.acquireTimer);
    clearInterval(this.renewTimer);
    for (const instrument of [...this.owned]) {
      this.owned.delete(instrument);
      await this.engine.stopInstrument(instrument);
      await this.lock
        .release(instrumentLockKey(instrument), this.ownerId)
        .catch((error: Error) =>
          this.logger.error(`Could not release ${instrument}: ${error.message}`),
        );
    }
  }

  private async exclusive(task: () => Promise<void>): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await task();
    } catch (error) {
      this.logger.error(`Ownership check failed: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async acquireFree(): Promise<void> {
    for (const instrument of INSTRUMENTS) {
      if (this.stopped || this.owned.has(instrument)) continue;
      const token = await this.lock.acquire(instrumentLockKey(instrument), this.ownerId, this.ttlMs);
      if (token === null) continue;
      this.owned.add(instrument);
      try {
        await this.engine.startInstrument(instrument);
        this.logger.log(`${this.ownerId} owns ${instrument} with token ${token}`);
      } catch (error) {
        this.owned.delete(instrument);
        await this.lock.release(instrumentLockKey(instrument), this.ownerId);
        throw error;
      }
    }
  }

  private async renewOwned(): Promise<void> {
    for (const instrument of [...this.owned]) {
      if (this.stopped) return;
      const renewed = await this.lock.renew(instrumentLockKey(instrument), this.ownerId, this.ttlMs);
      if (!renewed) await this.demote(instrument);
    }
  }

  private async demote(instrument: string): Promise<void> {
    this.owned.delete(instrument);
    await this.engine.stopInstrument(instrument);
    this.logger.warn(`${this.ownerId} lost ownership of ${instrument}`);
  }
}
