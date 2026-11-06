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
const REVOCATION_TTL_MS = 30 * 60_000;
const CLEANUP_EVERY_MS = 3_600_000;
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
  private lastCleanup = 0;

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

  async announce(familyIds: string[]): Promise<boolean> {
    if (familyIds.length === 0) return true;
    try {
      return await this.send(familyIds);
    } catch (error) {
      this.logger.warn(`Could not announce ended sessions yet, will retry: ${(error as Error).message}`);
      return false;
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
      const rows: { familyId: string }[] = await this.dataSource.query(
        `SELECT "familyId" FROM "session_revocations"
          WHERE "announcedAt" IS NULL AND "revokedAt" > now() - make_interval(secs => $1)
          ORDER BY "revokedAt"
          LIMIT ${RETRY_BATCH}`,
        [REVOCATION_TTL_MS / 1000],
      );
      await this.send(rows.map((row) => row.familyId));
      if (Date.now() - this.lastCleanup >= CLEANUP_EVERY_MS) {
        this.lastCleanup = Date.now();
        await this.dataSource.query(
          `DELETE FROM "session_revocations" WHERE "revokedAt" < now() - make_interval(secs => $1)`,
          [KEEP_RECORDS_MS / 1000],
        );
      }
    } catch (error) {
      this.logger.warn(`Could not announce ended sessions, retrying: ${(error as Error).message}`);
    }
  }

  private async send(familyIds: string[]): Promise<boolean> {
    if (familyIds.length === 0) return true;
    const commands = this.redis.client.multi();
    for (const familyId of familyIds) {
      commands.set(revokedSessionKey(familyId), '1', 'PX', REVOCATION_TTL_MS);
    }
    for (const familyId of familyIds) commands.publish(LOGOUT_CHANNEL, familyId);
    const results = await withTimeout(commands.exec(), REDIS_TIMEOUT_MS, 'Redis').catch(
      (error: Error) => {
        this.logger.warn(`Could not announce ended sessions yet, will retry: ${error.message}`);
        return null;
      },
    );
    if (!results || results.some(([error]) => error)) return false;
    await this.dataSource.query(
      `UPDATE "session_revocations" SET "announcedAt" = now() WHERE "familyId" = ANY($1::uuid[])`,
      [familyIds],
    );
    return true;
  }
}
