import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { withTimeout } from '../common/with-timeout';
import { intEnv } from '../common/env';

export const LOGOUT_CHANNEL = 'auth:logouts';
const REVOCATION_TTL_MS = 16 * 60_000;
const REDIS_TIMEOUT_MS = 1_000;
const RETRY_BATCH = 100;
const KEEP_RECORDS_MS = 24 * 3_600_000;

export function revokedSessionKey(sessionId: string): string {
  return `auth:revoked-session:${sessionId}`;
}

@Injectable()
export class SessionRevocations implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SessionRevocations.name);
  private readonly retryMs = intEnv('SESSION_REVOCATION_RETRY_MS', 2_000);
  private timer?: NodeJS.Timeout;
  private retrying?: Promise<void>;

  constructor(
    private readonly redis: RedisService,
    private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.retrying ??= this.announcePending().finally(() => (this.retrying = undefined));
    }, this.retryMs);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.retrying;
  }

  async record(manager: EntityManager, familyIds: string[]): Promise<void> {
    if (familyIds.length === 0) return;
    await manager.query(
      `INSERT INTO "session_revocations" ("familyId")
       SELECT unnest($1::uuid[])
       ON CONFLICT ("familyId") DO UPDATE SET "revokedAt" = now(), "announcedAt" = NULL`,
      [familyIds],
    );
  }

  async announce(familyIds: string[]): Promise<void> {
    if (familyIds.length === 0) return;
    try {
      const rows: { familyId: string; revokedAt: Date }[] = await this.dataSource.query(
        `SELECT "familyId", "revokedAt" FROM "session_revocations" WHERE "familyId" = ANY($1::uuid[])`,
        [familyIds],
      );
      await this.send(rows);
    } catch (error) {
      this.logger.warn(`Could not announce ended sessions yet, will retry: ${(error as Error).message}`);
    }
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    const revoked = await withTimeout(
      this.redis.client.exists(revokedSessionKey(sessionId)),
      REDIS_TIMEOUT_MS,
      'Redis',
    ).catch(() => {
      throw new ServiceUnavailableException('Could not check the session, try again');
    });
    return revoked === 1;
  }

  private async announcePending(): Promise<void> {
    try {
      const rows: { familyId: string; revokedAt: Date }[] = await this.dataSource.query(
        `SELECT "familyId", "revokedAt" FROM "session_revocations"
          WHERE "announcedAt" IS NULL AND "revokedAt" > now() - make_interval(secs => $1)
          ORDER BY "revokedAt"
          LIMIT ${RETRY_BATCH}`,
        [REVOCATION_TTL_MS / 1000],
      );
      await this.send(rows);
      await this.dataSource.query(
        `DELETE FROM "session_revocations" WHERE "revokedAt" < now() - make_interval(secs => $1)`,
        [KEEP_RECORDS_MS / 1000],
      );
    } catch (error) {
      this.logger.warn(`Could not announce ended sessions, retrying: ${(error as Error).message}`);
    }
  }

  private async send(rows: { familyId: string; revokedAt: Date }[]): Promise<void> {
    const live = rows
      .map((row) => ({
        familyId: row.familyId,
        ttlMs: new Date(row.revokedAt).getTime() + REVOCATION_TTL_MS - Date.now(),
      }))
      .filter((row) => row.ttlMs > 0);
    if (live.length === 0) return;
    const commands = this.redis.client.multi();
    for (const { familyId, ttlMs } of live) {
      commands.set(revokedSessionKey(familyId), '1', 'PX', Math.ceil(ttlMs));
    }
    for (const { familyId } of live) commands.publish(LOGOUT_CHANNEL, familyId);
    const results = await withTimeout(commands.exec(), REDIS_TIMEOUT_MS, 'Redis').catch(
      (error: Error) => {
        this.logger.warn(`Could not announce ended sessions yet, will retry: ${error.message}`);
        return null;
      },
    );
    if (!results || results.some(([error]) => error)) return;
    await this.dataSource.query(
      `UPDATE "session_revocations" SET "announcedAt" = now() WHERE "familyId" = ANY($1::uuid[])`,
      [live.map((row) => row.familyId)],
    );
  }
}
