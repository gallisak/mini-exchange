import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource, In } from 'typeorm';
import { Order } from '../entities/order.entity';
import { TradeRecord } from '../entities/trade-record.entity';
import { InstrumentState } from '../entities/instrument-state.entity';
import { OrderBookService } from '../order-book.service';
import { sortByPriceTimePriority } from '../matcher';
import { RedisService } from '../../redis/redis.service';
import { EngineState, applyCommands, isValidSubmit } from './apply-commands';
import { StreamCommand, commandStreamKey, decodeCommand } from './order-command';

export interface BookRunnerOptions {
  dataSource: DataSource;
  redis: RedisService;
  orderBook: OrderBookService;
  batchSize: number;
  blockMs: number;
  retryDelayMs: number;
}

type StreamEntry = [id: string, fields: string[]];

export class BookRunner {
  private readonly logger: Logger;
  private reader?: Redis;
  private readerId?: number;
  private running = false;
  private loop?: Promise<void>;
  private state!: EngineState;

  constructor(
    readonly instrument: string,
    private readonly options: BookRunnerOptions,
  ) {
    this.logger = new Logger(`BookRunner:${instrument}`);
  }

  async start(): Promise<void> {
    await this.load();
    this.reader = this.options.redis.createConnection();
    this.readerId = (await this.reader.client('ID')) as number;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.readerId !== undefined) {
      await this.options.redis.client.client('UNBLOCK', this.readerId).catch(() => undefined);
    }
    await this.loop;
    await this.reader?.quit().catch(() => this.reader?.disconnect());
  }

  private async load(): Promise<void> {
    const { dataSource, orderBook } = this.options;
    await dataSource
      .createQueryBuilder()
      .insert()
      .into(InstrumentState)
      .values({ instrument: this.instrument })
      .orIgnore()
      .execute();
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

    const result = applyCommands(
      this.instrument,
      orderBook.snapshot(this.instrument),
      this.state,
      commands,
      new Set(known.map((order) => order.id)),
    );

    await dataSource.transaction(async (manager) => {
      if (result.orders.length > 0) {
        await manager.upsert(Order, result.orders, ['id']);
      }
      if (result.trades.length > 0) {
        await manager.insert(TradeRecord, result.trades);
      }
      await manager.update(
        InstrumentState,
        { instrument: this.instrument },
        {
          lastCommandId: result.state.lastCommandId,
          orderSeq: result.state.orderSeq.toString(),
          tradeSeq: result.state.tradeSeq.toString(),
          bookSeq: result.state.bookSeq.toString(),
        },
      );
    });

    this.state = result.state;
    orderBook.replace(this.instrument, result.book);
  }
}
