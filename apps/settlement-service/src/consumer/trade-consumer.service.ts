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
import { tradeEvents } from '../observability/metrics';
import { closeRedis, createRedis } from '../common/redis';

const MAX_BACKOFF_MS = 5000;

type StreamEntry = [id: string, fields: string[]];
type PendingEntry = [id: string, consumer: string, idleMs: number, deliveries: number];

class SettlementFailedError extends Error {
  constructor(stream: string, id: string, cause: Error) {
    super(`Could not settle ${stream} ${id}, will retry: ${cause.message}`);
  }
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
    this.client = createRedis();
    this.reader = createRedis();
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
      await closeRedis(connection);
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
      await this.forgetIdleConsumers(stream);
    }
  }

  private async forgetIdleConsumers(stream: string): Promise<void> {
    const consumers = (await this.client!.xinfo('CONSUMERS', stream, this.options.group)) as (
      | string
      | number
    )[][];
    for (const fields of consumers) {
      const info: Record<string, string | number> = {};
      for (let i = 0; i + 1 < fields.length; i += 2) info[String(fields[i])] = fields[i + 1];
      if (
        info.name !== this.options.consumer &&
        Number(info.pending) === 0 &&
        Number(info.idle) >= this.options.idleConsumerMs
      ) {
        await this.client!.xgroup('DELCONSUMER', stream, this.options.group, String(info.name));
        this.logger.log(`Removed idle consumer ${info.name} from ${stream}`);
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
      result = await this.ledger.settleAndAnnounce(trade);
    } catch (error) {
      if (error instanceof InvalidTradeEventError || error instanceof TradeConflictError) {
        await this.deadLetter(stream, id, fields, deliveries, error.message);
        return;
      }
      tradeEvents.inc({ result: 'failed' });
      throw new SettlementFailedError(stream, id, error as Error);
    }
    await this.client!.xack(stream, this.options.group, id);
    tradeEvents.inc({ result });
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
    tradeEvents.inc({ result: 'dead_lettered' });
    this.logger.error(`Dead-lettered ${stream} ${id}: ${reason}`);
  }
}
