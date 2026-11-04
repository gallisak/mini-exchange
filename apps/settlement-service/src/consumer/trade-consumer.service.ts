import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { INSTRUMENTS } from '../common/instruments';
import { LedgerService } from '../ledger/ledger.service';
import { TradeConflictError } from '../ledger/trade-conflict.error';
import { ConsumerOptions, consumerOptionsFromEnv } from './consumer-options';
import {
  InvalidTradeEventError,
  fieldsOf,
  parseTradeEvent,
  traceIdOf,
  tradeStreamKey,
} from './trade-event';
import { runWithTrace } from '../observability/trace-context';

const MAX_BACKOFF_MS = 5000;

type StreamEntry = [id: string, fields: string[]];
type PendingEntry = [id: string, consumer: string, idleMs: number, deliveries: number];

class SettlementFailedError extends Error {
  constructor(stream: string, id: string, cause: Error) {
    super(`Could not settle ${stream} ${id}, will retry: ${cause.message}`);
  }
}

function redisConnection(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });
}

@Injectable()
export class TradeConsumerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TradeConsumerService.name);
  readonly options: ConsumerOptions = consumerOptionsFromEnv();
  private readonly streams = INSTRUMENTS.map(tradeStreamKey);
  private client?: Redis;
  private reader?: Redis;
  private readerId?: number;
  private running = false;
  private loop?: Promise<void>;
  private groupsReady = false;
  private lastReclaim = 0;

  constructor(private readonly ledger: LedgerService) {}

  onApplicationBootstrap(): void {
    if (process.env.CONSUMER_ENABLED === 'false') return;
    this.client = redisConnection();
    this.reader = redisConnection();
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.readerId !== undefined) {
      await this.client?.client('UNBLOCK', this.readerId).catch(() => undefined);
    }
    await this.loop;
    for (const connection of [this.reader, this.client]) {
      await connection?.quit().catch(() => connection.disconnect());
    }
  }

  private async run(): Promise<void> {
    let backoff = 100;
    while (this.running) {
      try {
        if (!this.groupsReady) await this.ensureGroups();
        if (Date.now() - this.lastReclaim >= this.options.reclaimEveryMs) {
          this.lastReclaim = Date.now();
          await this.reclaim();
        }
        await this.poll();
        backoff = 100;
      } catch (error) {
        if (!this.running) return;
        if (String((error as Error).message).includes('NOGROUP')) this.groupsReady = false;
        this.logger.warn(`Trade consumer failed, retrying in ${backoff} ms: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async ensureGroups(): Promise<void> {
    for (const stream of this.streams) {
      try {
        await this.client!.xgroup('CREATE', stream, this.options.group, '0', 'MKSTREAM');
      } catch (error) {
        if (!String((error as Error).message).includes('BUSYGROUP')) throw error;
      }
    }
    this.readerId = (await this.reader!.client('ID')) as number;
    this.groupsReady = true;
  }

  private async poll(): Promise<void> {
    const response = (await this.reader!.xreadgroup(
      'GROUP',
      this.options.group,
      this.options.consumer,
      'COUNT',
      this.options.batchSize,
      'BLOCK',
      this.options.blockMs,
      'STREAMS',
      ...this.streams,
      ...this.streams.map(() => '>'),
    )) as [stream: string, entries: StreamEntry[]][] | null;
    for (const [stream, entries] of response ?? []) {
      for (const [id, raw] of entries) {
        if (!this.running) return;
        await this.handle(stream, id, fieldsOf(raw), 1);
      }
    }
  }

  private async reclaim(): Promise<void> {
    const { group, consumer, retryIdleMs, batchSize } = this.options;
    for (const stream of this.streams) {
      const pending = (await this.client!.xpending(
        stream,
        group,
        'IDLE',
        retryIdleMs,
        '-',
        '+',
        batchSize,
      )) as PendingEntry[];
      for (const [id, , , deliveries] of pending) {
        if (!this.running) return;
        const claimed = (await this.client!.xclaim(stream, group, consumer, retryIdleMs, id)) as (
          | StreamEntry
          | null
        )[];
        for (const entry of claimed) {
          if (entry) await this.handle(stream, entry[0], fieldsOf(entry[1]), deliveries + 1);
        }
      }
    }
  }

  private handle(
    stream: string,
    id: string,
    fields: Record<string, string>,
    deliveries: number,
  ): Promise<void> {
    return runWithTrace(traceIdOf(fields), () => this.settle(stream, id, fields, deliveries));
  }

  private async settle(
    stream: string,
    id: string,
    fields: Record<string, string>,
    deliveries: number,
  ): Promise<void> {
    let tradeId: string;
    let result: string;
    try {
      const trade = await parseTradeEvent(fields);
      tradeId = trade.tradeId;
      result = await this.ledger.settleTrade(trade);
    } catch (error) {
      if (error instanceof InvalidTradeEventError || error instanceof TradeConflictError) {
        await this.deadLetter(stream, id, fields, deliveries, error.message);
        return;
      }
      throw new SettlementFailedError(stream, id, error as Error);
    }
    await this.client!.xack(stream, this.options.group, id);
    this.logger.log(`Trade ${tradeId} ${result} from ${stream} ${id}`);
  }

  private async deadLetter(
    stream: string,
    id: string,
    fields: Record<string, string>,
    deliveries: number,
    reason: string,
  ): Promise<void> {
    await this.client!.xadd(
      this.options.deadLetterStream,
      '*',
      'stream',
      stream,
      'id',
      id,
      'reason',
      reason,
      'deliveries',
      String(deliveries),
      'fields',
      JSON.stringify(fields),
    );
    await this.client!.xack(stream, this.options.group, id);
    this.logger.error(`Dead-lettered ${stream} ${id}: ${reason}`);
  }
}
