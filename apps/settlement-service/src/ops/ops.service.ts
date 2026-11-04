import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { INSTRUMENTS } from '../common/instruments';
import { closeRedis, createRedis } from '../common/redis';
import { consumerOptionsFromEnv } from '../consumer/consumer-options';
import { tradeStreamKey } from '../consumer/trade-event';

const CHECK_TIMEOUT_MS = 1000;

type CheckResult = 'up' | 'down';

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

function record(fields: (string | number)[]): Record<string, string | number> {
  const info: Record<string, string | number> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) info[String(fields[i])] = fields[i + 1];
  return info;
}

@Injectable()
export class OpsService implements OnApplicationShutdown {
  private readonly redis = createRedis({ maxRetriesPerRequest: 1 });
  private readonly options = consumerOptionsFromEnv();

  constructor(private readonly dataSource: DataSource) {}

  async health(): Promise<{ status: 'ok' | 'degraded'; checks: Record<string, CheckResult> }> {
    const check = (work: () => Promise<unknown>): Promise<CheckResult> =>
      withTimeout(work()).then(
        () => 'up',
        () => 'down',
      );
    const checks = {
      database: await check(() => this.dataSource.query('SELECT 1')),
      redis:
        this.redis.status === 'ready' ? await check(() => this.redis.ping()) : ('down' as const),
    };
    return {
      status: Object.values(checks).every((result) => result === 'up') ? 'ok' : 'degraded',
      checks,
    };
  }

  async status() {
    const streams = await Promise.all(
      INSTRUMENTS.map(async (instrument) => {
        const stream = tradeStreamKey(instrument);
        const groups = ((await this.redis.xinfo('GROUPS', stream).catch(() => [])) as (
          | string
          | number
        )[][]).map(record);
        const group = groups.find((info) => info.name === this.options.group);
        return {
          stream,
          length: await this.redis.xlen(stream),
          pending: Number(group?.pending ?? 0),
          lag: group?.lag === null || group?.lag === undefined ? null : Number(group.lag),
          consumers: Number(group?.consumers ?? 0),
        };
      }),
    );
    return {
      group: this.options.group,
      streams,
      deadLetters: await this.redis.xlen(this.options.deadLetterStream),
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(this.redis);
  }
}
