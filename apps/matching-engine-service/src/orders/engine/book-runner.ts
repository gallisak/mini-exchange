import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { DataSource, In } from "typeorm";
import { Order } from "../entities/order.entity";
import { TradeRecord } from "../entities/trade-record.entity";
import { InstrumentState } from "../entities/instrument-state.entity";
import { OrderBookService } from "../order-book.service";
import { sortByPriceTimePriority } from "../matcher";
import { RedisService, closeRedis } from "../../redis/redis.service";
import {
  EngineState,
  ExecutedTrade,
  applyCommands,
  isValidSubmit,
} from "./apply-commands";
import {
  StreamCommand,
  commandStreamKey,
  decodeCommand,
} from "./order-command";
import { FencedOutError } from "./fenced-out.error";
import { runWithTrace } from "../../observability/trace-context";
import { withTimeout } from "../../common/with-timeout";
import { bookBatchFailures, tradesExecuted } from "../../observability/metrics";
import { diffBooks } from "../depth";
import { publicTrade } from "../../trades/public-trade";
import { MarketEvent } from "../realtime/market-events";
import { OutboxMessage } from "../../outbox/outbox-message.entity";
import { tradeExecutedMessage } from "../../outbox/trade-event";

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
  publish?: (event: MarketEvent) => Promise<boolean | void>;
  resyncPending?: () => boolean;
  heartbeatMs?: number;
}

type StreamEntry = [id: string, fields: string[]];

const STUCK_TTL_MS = 30_000;
const ROWS_PER_INSERT = 1_000;
const MARKER_TIMEOUT_MS = 1_000;
const READ_TIMEOUT_MARGIN_MS = 2_000;
const READ_FAILURES_BEFORE_STUCK = 3;

function chunks<T>(rows: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT)
    result.push(rows.slice(i, i + ROWS_PER_INSERT));
  return result;
}

export function stuckKey(instrument: string): string {
  return `book:stuck:${instrument}`;
}

export function publishedKey(instrument: string): string {
  return `book:published:${instrument}`;
}

export interface StuckBook {
  since: string;
  failures: number;
  error: string;
}

export class BookRunner {
  private readonly logger: Logger;
  private reader?: Redis;
  private running = false;
  private loop?: Promise<void>;
  private heartbeat?: NodeJS.Timeout;
  private state!: EngineState;
  private stuck?: StuckBook;
  private stuckNoted = true;
  private readFailures = 0;
  private reloadNeeded = false;
  private updatesLost = false;

  constructor(
    readonly instrument: string,
    private readonly options: BookRunnerOptions,
  ) {
    this.logger = new Logger(`BookRunner:${instrument}`);
  }

  get fence(): bigint {
    return this.options.fence;
  }

  async start(): Promise<void> {
    await this.claimFence();
    await this.load();
    this.reader = this.options.redis.createConnection();
    this.running = true;
    this.loop = this.run();
    if (this.options.publish && this.options.heartbeatMs) {
      this.heartbeat = setInterval(
        () => this.announceSeq(),
        this.options.heartbeatMs,
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.heartbeat);
    const reader = this.reader;
    this.reader = undefined;
    reader?.disconnect();
    await this.loop;
    await closeRedis(reader);
  }

  private async publish(event: MarketEvent): Promise<boolean> {
    if (!this.options.publish) return true;
    return this.options
      .publish(event)
      .then((published) => published !== false)
      .catch(() => false);
  }

  private logApplied(
    commands: StreamCommand[],
    orders: Order[],
    trades: ExecutedTrade[],
  ): void {
    const statuses = new Map(orders.map((order) => [order.id, order.status]));
    for (const { id, command } of commands) {
      if (!command) continue;
      runWithTrace(command.traceId, () =>
        this.logger.log(
          `Applied ${command.type} ${command.orderId} from ${id}: ${statuses.get(command.orderId) ?? "unchanged"}`,
        ),
      );
    }
    for (const trade of trades) {
      runWithTrace(trade.traceId ?? undefined, () =>
        this.logger.log(
          `Trade ${trade.id} executed ${trade.quantity} @ ${trade.price}`,
        ),
      );
    }
  }

  private announceSeq(): void {
    if (!this.running || this.reloadNeeded || !this.options.leaseValid())
      return;
    void this.publish({
      type: "book_heartbeat",
      heartbeat: {
        instrument: this.instrument,
        seq: Number(this.state.bookSeq),
        intervalMs: this.options.heartbeatMs ?? 0,
      },
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
      .where("instrument = :instrument AND fence < :fence", {
        instrument: this.instrument,
        fence: fence.toString(),
      })
      .execute();
    if (claimed.affected === 0) {
      throw new FencedOutError(
        this.instrument,
        fence,
        await this.currentFence(),
      );
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
      where: {
        instrument: this.instrument,
        status: In(["open", "partially_filled"]),
      },
    });
    orderBook.replace(this.instrument, {
      bids: sortByPriceTimePriority(
        open.filter((order) => order.side === "buy"),
        "buy",
      ),
      asks: sortByPriceTimePriority(
        open.filter((order) => order.side === "sell"),
        "sell",
      ),
    });
    this.logger.log(
      `Loaded ${open.length} open orders, resuming after command ${this.state.lastCommandId}`,
    );
    await this.announceUnpublished();
  }

  private async announceUnpublished(): Promise<void> {
    const key = publishedKey(this.instrument);
    const published = await withTimeout(
      this.options.redis.client.get(key),
      MARKER_TIMEOUT_MS,
      "Redis",
    ).catch(() => null);
    const bookSeq = this.state.bookSeq;
    if (bookSeq === 0n) return;
    if (
      published !== null &&
      /^\d+$/.test(published) &&
      BigInt(published) >= bookSeq
    )
      return;
    this.logger.warn(
      `Changes up to book seq ${bookSeq} may not have been published, telling clients to reload`,
    );
    const announced = await this.publish({
      type: "resync",
      resync: { instruments: [this.instrument], owners: [], allOwners: true },
    });
    if (announced) await this.markPublished(bookSeq);
    else this.updatesLost = true;
  }

  private async markPublished(bookSeq: bigint): Promise<void> {
    await withTimeout(
      this.options.redis.client.set(
        publishedKey(this.instrument),
        bookSeq.toString(),
      ),
      MARKER_TIMEOUT_MS,
      "Redis",
    ).catch(() => undefined);
  }

  private async run(): Promise<void> {
    const { batchSize, blockMs, retryDelayMs } = this.options;
    while (this.running) {
      try {
        if (this.reloadNeeded) {
          await this.load();
          this.reloadNeeded = false;
        }
        let response: [string, StreamEntry[]][] | null;
        try {
          response = await this.read(batchSize, blockMs);
          this.readFailures = 0;
        } catch (error) {
          if (!this.running) return;
          this.readFailures += 1;
          this.logger.warn(
            `Reading the command stream failed ${this.readFailures} times in a row, reading again: ${(error as Error).message}`,
          );
          if (this.readFailures >= READ_FAILURES_BEFORE_STUCK) {
            await this.failed(error as Error);
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        if (!response) {
          await this.recovered();
          continue;
        }
        const entries = response[0][1];
        await this.process(
          entries.map(([id, fields]) => ({
            id,
            command: decodeCommand(fields),
          })),
        );
        await this.recovered();
      } catch (error) {
        if (!this.running) return;
        if (error instanceof FencedOutError) {
          this.running = false;
          this.logger.warn(error.message);
          setImmediate(() => this.options.onFenced(error));
          return;
        }
        this.logger.error(
          `${this.reloadNeeded ? "Reload" : "Batch"} failed, reloading state: ${(error as Error).message}`,
        );
        this.reloadNeeded = true;
        await this.failed(error as Error);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  private async read(
    batchSize: number,
    blockMs: number,
  ): Promise<[string, StreamEntry[]][] | null> {
    const reader = this.reader!;
    try {
      return (await withTimeout(
        reader.xread(
          "COUNT",
          batchSize,
          "BLOCK",
          blockMs,
          "STREAMS",
          commandStreamKey(this.instrument),
          this.state.lastCommandId,
        ),
        blockMs + READ_TIMEOUT_MARGIN_MS,
        "Redis",
      )) as [string, StreamEntry[]][] | null;
    } catch (error) {
      if (this.running && this.reader === reader) {
        reader.disconnect();
        this.reader = this.options.redis.createConnection();
      }
      throw error;
    }
  }

  private async failed(error: Error): Promise<void> {
    bookBatchFailures.inc({ instrument: this.instrument });
    this.stuck = {
      since: this.stuck?.since ?? new Date().toISOString(),
      failures: (this.stuck?.failures ?? 0) + 1,
      error: error.message.slice(0, 500),
    };
    this.stuckNoted = true;
    await withTimeout(
      this.options.redis.client.set(
        stuckKey(this.instrument),
        JSON.stringify(this.stuck),
        "PX",
        STUCK_TTL_MS,
      ),
      MARKER_TIMEOUT_MS,
      "Redis",
    ).catch(() => undefined);
  }

  private async recovered(): Promise<void> {
    if (!this.stuckNoted) return;
    if (this.stuck) {
      this.logger.log(
        `Batch committed again after ${this.stuck.failures} failed attempts`,
      );
    }
    this.stuck = undefined;
    this.stuckNoted = await withTimeout(
      this.options.redis.client.del(stuckKey(this.instrument)),
      MARKER_TIMEOUT_MS,
      "Redis",
    ).then(
      () => false,
      () => true,
    );
  }

  private async process(commands: StreamCommand[]): Promise<void> {
    const { dataSource, orderBook } = this.options;
    const submitIds = commands.flatMap((entry) =>
      entry.command?.type === "submit" && isValidSubmit(entry.command)
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
        throw new FencedOutError(
          this.instrument,
          this.options.fence,
          await this.currentFence(),
        );
      }
      for (const orders of chunks(result.orders)) {
        await manager.upsert(Order, orders, ["id"]);
      }
      for (const trades of chunks(result.trades)) {
        await manager.insert(TradeRecord, trades);
        await manager.insert(OutboxMessage, trades.map(tradeExecutedMessage));
      }
    });

    const previousSeq = this.state.bookSeq;
    this.state = result.state;
    orderBook.replace(this.instrument, result.book);
    this.logApplied(commands, result.orders, result.trades);
    tradesExecuted.inc({ instrument: this.instrument }, result.trades.length);

    const updates: Promise<boolean>[] = [];
    if (result.trades.length > 0) {
      updates.push(
        this.publish({
          type: "trades",
          trades: result.trades.map(publicTrade),
        }),
      );
    }
    if (result.orders.length > 0) {
      updates.push(
        this.publish({
          type: "orders",
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
        }),
      );
    }
    if (result.state.bookSeq !== previousSeq) {
      updates.push(
        this.publish({
          type: "book_delta",
          delta: {
            instrument: this.instrument,
            seq: Number(result.state.bookSeq),
            changes: diffBooks(before, result.book),
          },
        }),
      );
    }
    const published = await Promise.all(updates);
    if (!published.every(Boolean)) this.updatesLost = true;
    else if (
      this.updatesLost &&
      this.options.resyncPending &&
      !this.options.resyncPending()
    ) {
      this.updatesLost = false;
    }
    if (result.state.bookSeq !== previousSeq && !this.updatesLost) {
      await this.markPublished(result.state.bookSeq);
    }
  }
}
