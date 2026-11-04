import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DataSource, In, IsNull, LessThan } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { OutboxMessage } from './outbox-message.entity';
import { runWithTrace } from '../observability/trace-context';

const RELAY_LOCK_KEY = 7_340_101;
const MAX_BACKOFF_MS = 5_000;

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly pollMs = Number(process.env.OUTBOX_POLL_MS ?? 100);
  private readonly batchSize = Number(process.env.OUTBOX_BATCH_SIZE ?? 100);
  private readonly retentionMs = Number(process.env.OUTBOX_RETENTION_HOURS ?? 24) * 3_600_000;
  private readonly cleanupEveryMs = Number(process.env.OUTBOX_CLEANUP_INTERVAL_MS ?? 60_000);
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
      const results = await batch.exec();
      const failed = (results ?? []).find(([error]) => error);
      if (!results || failed) throw failed?.[0] ?? new Error('Redis transaction was aborted');

      await manager.update(
        OutboxMessage,
        { id: In(pending.map((message) => message.id)) },
        { publishedAt: () => 'now()' },
      );
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
    const result = await this.dataSource.getRepository(OutboxMessage).delete({
      publishedAt: LessThan(new Date(Date.now() - olderThanMs)),
    });
    return result.affected ?? 0;
  }

  private async run(): Promise<void> {
    let delay = this.pollMs;
    while (this.running) {
      try {
        const published = await this.publishPending();
        delay = this.pollMs;
        if (Date.now() - this.lastCleanup >= this.cleanupEveryMs) {
          this.lastCleanup = Date.now();
          await this.purgePublished();
        }
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
