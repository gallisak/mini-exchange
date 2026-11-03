import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { INSTRUMENTS } from '../../common/instruments';
import { RedisLockService } from '../../locks/redis-lock.service';
import { MatchingEngineService } from './matching-engine.service';
import { FencedOutError } from './fenced-out.error';

export function instrumentLockKey(instrument: string): string {
  return `lock:instrument:${instrument}`;
}

interface Lease {
  token: bigint;
  renewedAt: number;
}

@Injectable()
export class InstrumentOwnershipService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InstrumentOwnershipService.name);
  private readonly ownerId = `${process.env.INSTANCE_ID ?? 'engine'}:${randomUUID()}`;
  private readonly ttlMs = Number(process.env.LOCK_TTL_MS ?? 5000);
  private readonly renewIntervalMs = Number(process.env.LOCK_RENEW_INTERVAL_MS ?? 1500);
  private readonly acquireIntervalMs = Number(process.env.LOCK_ACQUIRE_INTERVAL_MS ?? 1000);
  private readonly safetyMarginMs = Math.max(this.ttlMs / 5, 200);
  private readonly owned = new Map<string, Lease>();
  private acquireTimer?: NodeJS.Timeout;
  private renewTimer?: NodeJS.Timeout;
  private acquiring?: Promise<void>;
  private renewing = false;
  private stopped = false;

  constructor(
    private readonly lock: RedisLockService,
    private readonly engine: MatchingEngineService,
  ) {}

  ownedInstruments(): string[] {
    return [...this.owned.keys()];
  }

  async onApplicationBootstrap(): Promise<void> {
    this.renewTimer = setInterval(() => void this.renewTick(), this.renewIntervalMs);
    this.acquireTimer = setInterval(() => void this.acquireTick(), this.acquireIntervalMs);
    await this.acquireTick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.acquireTimer);
    clearInterval(this.renewTimer);
    await this.acquiring;
    for (const instrument of [...this.owned.keys()]) {
      this.owned.delete(instrument);
      await this.engine.stopInstrument(instrument);
      await this.lock
        .release(instrumentLockKey(instrument), this.ownerId)
        .catch((error: Error) =>
          this.logger.error(`Could not release ${instrument}: ${error.message}`),
        );
    }
  }

  private acquireTick(): Promise<void> {
    if (this.acquiring || this.stopped) return Promise.resolve();
    this.acquiring = this.acquireFree()
      .catch((error: Error) => this.logger.error(`Acquiring instruments failed: ${error.message}`))
      .finally(() => {
        this.acquiring = undefined;
      });
    return this.acquiring;
  }

  private async renewTick(): Promise<void> {
    if (this.renewing || this.stopped) return;
    this.renewing = true;
    try {
      await this.renewOwned();
    } catch (error) {
      this.logger.error(`Renewing leases failed: ${(error as Error).message}`);
    } finally {
      this.renewing = false;
    }
  }

  private isLeaseValid(instrument: string, token: bigint): boolean {
    const lease = this.owned.get(instrument);
    return (
      lease !== undefined &&
      lease.token === token &&
      performance.now() < lease.renewedAt + this.ttlMs - this.safetyMarginMs
    );
  }

  private async acquireFree(): Promise<void> {
    for (const instrument of INSTRUMENTS) {
      if (this.stopped || this.owned.has(instrument)) continue;
      const key = instrumentLockKey(instrument);
      const requestedAt = performance.now();
      const token = await this.lock.acquire(key, this.ownerId, this.ttlMs);
      if (token === null) continue;
      this.owned.set(instrument, { token, renewedAt: requestedAt });
      try {
        await this.engine.startInstrument(instrument, {
          fence: token,
          isValid: () => this.isLeaseValid(instrument, token),
          onFenced: (error) => void this.stepDown(instrument, token, error),
        });
        this.logger.log(`${this.ownerId} owns ${instrument} with token ${token}`);
      } catch (error) {
        this.owned.delete(instrument);
        await this.lock.release(key, this.ownerId);
        if (error instanceof FencedOutError && error.currentFence !== null) {
          await this.lock.raiseFence(key, error.currentFence);
          this.logger.warn(error.message);
          continue;
        }
        throw error;
      }
    }
  }

  private async renewOwned(): Promise<void> {
    for (const [instrument, lease] of [...this.owned]) {
      if (this.stopped) return;
      const requestedAt = performance.now();
      try {
        if (await this.lock.renew(instrumentLockKey(instrument), this.ownerId, this.ttlMs)) {
          lease.renewedAt = requestedAt;
          continue;
        }
        await this.demote(instrument, 'the lock is held by someone else');
      } catch (error) {
        this.logger.error(`Could not renew ${instrument}: ${(error as Error).message}`);
        if (!this.isLeaseValid(instrument, lease.token)) {
          await this.demote(instrument, 'the lease expired while Redis was unreachable');
        }
      }
    }
  }

  private async stepDown(instrument: string, token: bigint, error: FencedOutError): Promise<void> {
    if (this.owned.get(instrument)?.token !== token) return;
    this.owned.delete(instrument);
    this.logger.warn(`${this.ownerId} lost ownership of ${instrument}: ${error.message}`);
    const key = instrumentLockKey(instrument);
    await this.lock.release(key, this.ownerId).catch(() => undefined);
    if (error.currentFence !== null) {
      await this.lock.raiseFence(key, error.currentFence).catch(() => undefined);
    }
  }

  private async demote(instrument: string, reason: string): Promise<void> {
    this.owned.delete(instrument);
    await this.engine.stopInstrument(instrument);
    this.logger.warn(`${this.ownerId} lost ownership of ${instrument}: ${reason}`);
  }
}
