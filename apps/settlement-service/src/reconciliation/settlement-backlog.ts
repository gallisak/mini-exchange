import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { INSTRUMENTS } from "../common/instruments";
import { closeRedis, createRedis } from "../common/redis";
import { tradeStreamKey } from "../consumer/trade-event";

type StreamEntry = [id: string, fields: string[]];

const REDIS_TIMEOUT_MS = 2_000;
const SCAN_PAGE = 1_000;

async function within<T>(command: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Redis did not answer within ${REDIS_TIMEOUT_MS} ms`)),
      REDIS_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([command, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function executedAtOf(entry: StreamEntry | undefined): number | null {
  if (!entry) return null;
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < entry[1].length; i += 2)
    fields[entry[1][i]] = entry[1][i + 1];
  try {
    const executedAt = new Date(
      (JSON.parse(fields.payload) as { executedAt?: unknown })
        .executedAt as string,
    ).getTime();
    return Number.isNaN(executedAt) ? null : executedAt;
  } catch {
    return null;
  }
}

@Injectable()
export class SettlementBacklog implements OnModuleDestroy {
  private readonly redis = createRedis({ maxRetriesPerRequest: 1 });
  private readonly group = process.env.CONSUMER_GROUP ?? "settlement";

  async onModuleDestroy(): Promise<void> {
    await closeRedis(this.redis);
  }

  async oldestUnsettled(): Promise<Date | null> {
    const oldest = await Promise.all(
      INSTRUMENTS.map((instrument) =>
        this.oldestIn(tradeStreamKey(instrument)),
      ),
    );
    const known = oldest.filter((time): time is number => time !== null);
    return known.length > 0 ? new Date(Math.min(...known)) : null;
  }

  private async oldestIn(stream: string): Promise<number | null> {
    if ((await within(this.redis.exists(stream))) === 0) return null;
    const groups = (await within(this.redis.xinfo("GROUPS", stream))) as (
      string | number
    )[][];
    const group = groups
      .map((fields) => {
        const info: Record<string, string | number> = {};
        for (let i = 0; i + 1 < fields.length; i += 2)
          info[String(fields[i])] = fields[i + 1];
        return info;
      })
      .find((info) => info.name === this.group);
    const lastDelivered = group ? String(group["last-delivered-id"]) : "0-0";
    let start = `(${lastDelivered}`;
    if (group) {
      const [count, smallest] = (await within(
        this.redis.xpending(stream, this.group),
      )) as [number, string | null];
      if (count > 0 && smallest) start = smallest;
    }
    let oldest: number | null = null;
    for (;;) {
      const entries = (await within(
        this.redis.xrange(stream, start, "+", "COUNT", SCAN_PAGE),
      )) as StreamEntry[];
      for (const entry of entries) {
        const executedAt = executedAtOf(entry);
        if (executedAt !== null && (oldest === null || executedAt < oldest))
          oldest = executedAt;
      }
      if (entries.length < SCAN_PAGE) return oldest;
      start = `(${entries[entries.length - 1][0]}`;
    }
  }
}
