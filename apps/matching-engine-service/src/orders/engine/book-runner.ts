import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource, In } from 'typeorm';
import { Order } from '../entities/order.entity';
import { TradeRecord } from '../entities/trade-record.entity';
import { InstrumentState } from '../entities/instrument-state.entity';
import { OrderBookService } from '../order-book.service';
import { sortByPriceTimePriority } from '../matcher';
import { RedisService, closeRedis } from '../../redis/redis.service';
import { EngineState, ExecutedTrade, applyCommands, isValidSubmit } from './apply-commands';
import { StreamCommand, commandStreamKey, decodeCommand } from './order-command';
import { FencedOutError } from './fenced-out.error';
import { runWithTrace } from '../../observability/trace-context';
import { tradesExecuted } from '../../observability/metrics';
import { diffBooks } from '../depth';
import { publicTrade } from '../../trades/public-trade';
import { MarketEvent } from '../realtime/market-events';
import { OutboxMessage } from '../../outbox/outbox-message.entity';
import { tradeExecutedMessage } from '../../outbox/trade-event';

export interface BookRunnerOptions {
  dataSource: DataSource;
  redis: RedisService;
  orderBook: OrderBookService;
  batchSize: number;
  blockMs: number;
  retryDelayMs: number;
  fence: bigint;
  leaseValid: () => boolean;
  onFenced: (error: FencedOutError) => void;
  publish?: (event: MarketEvent) => Promise<void>;
  heartbeatMs?: number;
}

type StreamEntry = [id: string, fields: string[]];

export class BookRunner {
  private readonly logger: Logger;
  private reader?: Redis;
  private readerId?: number;
  private running = false;
  private loop?: Promise<void>;
  private heartbeat?: NodeJS.Timeout;
  private state!: EngineState;

  constructor(
    readonly instrument: string,
    private readonly options: BookRunnerOptions,
  ) {
    this.logger = new Logger(`BookRunner:${instrument}`);
  }

  async start(): Promise<void> {
    await this.claimFence();
    await this.load();
    this.reader = this.options.redis.createConnection();
    this.readerId = (await this.reader.client('ID')) as number;
    this.running = true;
    this.loop = this.run();
    if (this.options.publish && this.options.heartbeatMs) {
      this.heartbeat = setInterval(() => this.announceSeq(), this.options.heartbeatMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.heartbeat);
    const reader = this.reader;
    const readerId = this.readerId;
    this.reader = undefined;
    this.readerId = undefined;
    if (readerId !== undefined) {
      await this.options.redis.client.client('UNBLOCK', readerId).catch(() => undefined);
    }
    await this.loop;
    await closeRedis(reader);
  }

  private logApplied(commands: StreamCommand[], orders: Order[], trades: ExecutedTrade[]): void {
    const statuses = new Map(orders.map((order) => [order.id, order.status]));
    for (const { id, command } of commands) {
      if (!command) continue;
      runWithTrace(command.traceId, () =>
        this.logger.log(
          `Applied ${command.type} ${command.orderId} from ${id}: ${statuses.get(command.orderId) ?? 'unchanged'}`,
        ),
      );
    }
    for (const trade of trades) {
      runWithTrace(trade.traceId ?? undefined, () =>
        this.logger.log(`Trade ${trade.id} executed ${trade.quantity} @ ${trade.price}`),
      );
    }
  }

  private announceSeq(): void {
    if (!this.running) return;
    void this.options.publish?.({
      type: 'book_heartbeat',
      heartbeat: { instrument: this.instrument, seq: Number(this.state.bookSeq) },
    });
  }

  private async claimFence(): Promise<void> {
    const { dataSource, fence } = this.options;
    await dataSource
      .createQueryBuilder()
      .insert()
      .into(InstrumentState)
      .values({ instrument: this.instrument })
      .orIgnore()
      .execute();
    const claimed = await dataSource
      .createQueryBuilder()
      .update(InstrumentState)
      .set({ fence: fence.toString() })
      .where('instrument = :instrument AND fence < :fence', {
        instrument: this.instrument,
        fence: fence.toString(),
      })
      .execute();
    if (claimed.affected === 0) {
      throw new FencedOutError(this.instrument, fence, await this.currentFence());
    }
  }

  private async currentFence(): Promise<bigint> {
    const row = await this.options.dataSource
      .getRepository(InstrumentState)
      .findOneByOrFail({ instrument: this.instrument });
    return BigInt(row.fence);
  }

  private async load(): Promise<void> {
    const { dataSource, orderBook } = this.options;
    const row = await dataSource
      .getRepository(InstrumentState)
      .findOneByOrFail({ instrument: this.instrument });
    this.state = {
      lastCommandId: row.lastCommandId,
      orderSeq: BigInt(row.orderSeq),
      tradeSeq: BigInt(row.tradeSeq),
      bookSeq: BigInt(row.bookSeq),
    };

    const open = await dataSource.getRepository(Order).find({
      where: { instrument: this.instrument, status: In(['open', 'partially_filled']) },
    });
    orderBook.replace(this.instrument, {
      bids: sortByPriceTimePriority(
        open.filter((order) => order.side === 'buy'),
        'buy',
      ),
      asks: sortByPriceTimePriority(
        open.filter((order) => order.side === 'sell'),
        'sell',
      ),
    });
    this.logger.log(
      `Loaded ${open.length} open orders, resuming after command ${this.state.lastCommandId}`,
    );
  }

  private async run(): Promise<void> {
    const { batchSize, blockMs, retryDelayMs } = this.options;
    while (this.running) {
      try {
        const response = (await this.reader!.xread(
          'COUNT',
          batchSize,
          'BLOCK',
          blockMs,
          'STREAMS',
          commandStreamKey(this.instrument),
          this.state.lastCommandId,
        )) as [string, StreamEntry[]][] | null;
        if (!response) continue;
        const entries = response[0][1];
        await this.process(entries.map(([id, fields]) => ({ id, command: decodeCommand(fields) })));
      } catch (error) {
        if (!this.running) return;
        if (error instanceof FencedOutError) {
          this.running = false;
          this.logger.warn(error.message);
          setImmediate(() => this.options.onFenced(error));
          return;
        }
        this.logger.error(`Batch failed, reloading state: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        await this.load().catch((loadError: Error) =>
          this.logger.error(`Reload failed: ${loadError.message}`),
        );
      }
    }
  }

  private async process(commands: StreamCommand[]): Promise<void> {
    const { dataSource, orderBook } = this.options;
    const submitIds = commands.flatMap((entry) =>
      entry.command?.type === 'submit' && isValidSubmit(entry.command)
        ? [entry.command.orderId]
        : [],
    );
    const known =
      submitIds.length === 0
        ? []
        : await dataSource
            .getRepository(Order)
            .find({ select: { id: true }, where: { id: In(submitIds) } });

    const before = orderBook.snapshot(this.instrument);
    const result = applyCommands(
      this.instrument,
      before,
      this.state,
      commands,
      new Set(known.map((order) => order.id)),
    );

    if (!this.options.leaseValid()) {
      throw new FencedOutError(this.instrument, this.options.fence, null);
    }

    await dataSource.transaction(async (manager) => {
      const fenced = await manager.update(
        InstrumentState,
        { instrument: this.instrument, fence: this.options.fence.toString() },
        {
          lastCommandId: result.state.lastCommandId,
          orderSeq: result.state.orderSeq.toString(),
          tradeSeq: result.state.tradeSeq.toString(),
          bookSeq: result.state.bookSeq.toString(),
        },
      );
      if (fenced.affected === 0) {
        throw new FencedOutError(this.instrument, this.options.fence, await this.currentFence());
      }
      if (result.orders.length > 0) {
        await manager.upsert(Order, result.orders, ['id']);
      }
      if (result.trades.length > 0) {
        await manager.insert(TradeRecord, result.trades);
        await manager.insert(OutboxMessage, result.trades.map(tradeExecutedMessage));
      }
    });

    const previousSeq = this.state.bookSeq;
    this.state = result.state;
    orderBook.replace(this.instrument, result.book);
    this.logApplied(commands, result.orders, result.trades);
    tradesExecuted.inc({ instrument: this.instrument }, result.trades.length);

    if (result.trades.length > 0) {
      void this.options.publish?.({
        type: 'trades',
        trades: result.trades.map(publicTrade),
      });
    }
    if (result.orders.length > 0) {
      void this.options.publish?.({
        type: 'orders',
        orders: result.orders.map((order) => ({
          id: order.id,
          ownerId: order.ownerId,
          instrument: order.instrument,
          side: order.side,
          price: order.price,
          quantity: order.quantity,
          remainingQuantity: order.remainingQuantity,
          status: order.status,
          createdAt: order.createdAt.toISOString(),
        })),
      });
    }
    if (result.state.bookSeq !== previousSeq) {
      void this.options.publish?.({
        type: 'book_delta',
        delta: {
          instrument: this.instrument,
          seq: Number(result.state.bookSeq),
          changes: diffBooks(before, result.book),
        },
      });
    }
  }
}
