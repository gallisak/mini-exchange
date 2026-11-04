import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { INSTRUMENTS } from '../common/instruments';
import { RedisService } from '../redis/redis.service';
import { InstrumentState } from '../orders/entities/instrument-state.entity';
import { OutboxMessage } from '../outbox/outbox-message.entity';
import { commandStreamKey } from '../orders/engine/order-command';
import {
  InstrumentOwnershipService,
  instrumentLockKey,
} from '../orders/engine/instrument-ownership.service';

const CHECK_TIMEOUT_MS = 1000;
const LAG_SCAN_LIMIT = 10_000;

type CheckResult = 'up' | 'down';

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

@Injectable()
export class OpsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly ownership: InstrumentOwnershipService,
  ) {}

  async health(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, CheckResult> }> {
    const check = (work: () => Promise<unknown>): Promise<CheckResult> =>
      withTimeout(work()).then(
        () => 'up',
        () => 'down',
      );
    const checks = {
      database: await check(() => this.dataSource.query('SELECT 1')),
      redis: this.redis.isReady() ? await check(() => this.redis.client.ping()) : ('down' as const),
    };
    return {
      status: Object.values(checks).every((result) => result === 'up') ? 'ok' : 'degraded',
      checks,
    };
  }

  async status() {
    const owned = new Set(this.ownership.ownedInstruments());
    const states = new Map(
      (await this.dataSource.getRepository(InstrumentState).find()).map((state) => [
        state.instrument,
        state,
      ]),
    );
    const instruments = await Promise.all(
      INSTRUMENTS.map(async (instrument) => {
        const state = states.get(instrument);
        const lastCommandId = state?.lastCommandId ?? '0-0';
        const [owner, streamLength, pending] = await Promise.all([
          this.redis.client.get(instrumentLockKey(instrument)),
          this.redis.client.xlen(commandStreamKey(instrument)),
          this.redis.client.xrange(
            commandStreamKey(instrument),
            `(${lastCommandId}`,
            '+',
            'COUNT',
            LAG_SCAN_LIMIT,
          ),
        ]);
        return {
          instrument,
          owner,
          ownedHere: owned.has(instrument),
          fence: state?.fence ?? '0',
          bookSeq: Number(state?.bookSeq ?? 0),
          lastCommandId,
          commandStreamLength: streamLength,
          commandsBehind: pending.length,
        };
      }),
    );
    return {
      instance: this.ownership.identity(),
      instruments,
      outboxPending: await this.dataSource
        .getRepository(OutboxMessage)
        .count({ where: { publishedAt: IsNull() } }),
    };
  }
}
