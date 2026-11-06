import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { OutboxMessage } from './outbox-message.entity';
import { runWithTrace } from '../observability/trace-context';
import { outboxPublished } from '../observability/metrics';
import { intEnv } from '../common/env';
import { withTimeout } from '../common/with-timeout';

const RELAY_LOCK_KEY = 7_340_101;
const MAX_BACKOFF_MS = 5_000;

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly pollMs = intEnv('OUTBOX_POLL_MS', 100);
  private readonly batchSize = intEnv('OUTBOX_BATCH_SIZE', 100);
  private readonly retentionMs = intEnv('OUTBOX_RETENTION_HOURS', 24) * 3_600_000;
  private readonly cleanupEveryMs = intEnv('OUTBOX_CLEANUP_INTERVAL_MS', 60_000);
  private readonly publishTimeoutMs = intEnv('OUTBOX_PUBLISH_TIMEOUT_MS', 5_000);
  private readonly purgeBatch = intEnv('OUTBOX_PURGE_BATCH', 1_000);
  private lastCleanup = 0;
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  async publishPending(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const [{ locked }] = await manager.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [
        RELAY_LOCK_KEY,
      ]);
      if (!locked) return 0;
      const pending = await manager.find(OutboxMessage, {
        where: { publishedAt: IsNull() },
        order: { id: 'ASC' },
        take: this.batchSize,
      });
      if (pending.length === 0) return 0;

      const batch = this.redis.client.multi();
      for (const message of pending) {
        batch.xadd(
          message.stream,
          '*',
          'type',
          message.type,
          'payload',
          JSON.stringify(message.payload),
        );
      }
      const results = await withTimeout(batch.exec(), this.publishTimeoutMs, 'Redis');
      const failed = (results ?? []).find(([error]) => error);
      if (!results || failed) throw failed?.[0] ?? new Error('Redis transaction was aborted');

      await manager.update(
        OutboxMessage,
        { id: In(pending.map((message) => message.id)) },
        { publishedAt: () => 'now()' },
      );
      outboxPublished.inc(pending.length);
      for (const message of pending) {
        const traceId = message.payload.traceId;
        runWithTrace(typeof traceId === 'string' ? traceId : undefined, () =>
          this.logger.log(`Published ${message.type} ${message.payload.tradeId ?? message.id} to ${message.stream}`),
        );
      }
      return pending.length;
    });
  }

  async purgePublished(olderThanMs = this.retentionMs): Promise<number> {
    const [, deleted]: [unknown, number] = await this.dataSource.query(
      `DELETE FROM "outbox" WHERE "id" IN (
         SELECT "id" FROM "outbox"
          WHERE "publishedAt" < $1
          LIMIT ${this.purgeBatch}
          FOR UPDATE SKIP LOCKED)`,
      [new Date(Date.now() - olderThanMs)],
    );
    return deleted;
  }

  private async purgeDue(): Promise<void> {
    if (Date.now() - this.lastCleanup < this.cleanupEveryMs) return;
    const purged = await this.purgePublished().catch((error: Error) => {
      this.logger.warn(`Could not purge the outbox: ${error.message}`);
      return 0;
    });
    if (purged < this.purgeBatch) this.lastCleanup = Date.now();
  }

  private async run(): Promise<void> {
    let delay = this.pollMs;
    while (this.running) {
      try {
        const published = await this.publishPending();
        delay = this.pollMs;
        await this.purgeDue();
        if (published > 0) continue;
      } catch (error) {
        if (!this.running) return;
        this.logger.warn(`Outbox publish failed, retrying in ${delay} ms: ${(error as Error).message}`);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
      await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
