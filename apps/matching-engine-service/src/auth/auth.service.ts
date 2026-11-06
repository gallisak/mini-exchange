import { ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { isUUID } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { User } from './entities/user.entity';
import { RefreshSession } from './entities/refresh-session.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { requireEnv } from '../common/env';
import { SessionRevocations } from './session-revocations.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const INVALID_CREDENTIALS = 'Invalid email or password';
const INVALID_REFRESH = 'Refresh token is invalid or was already used';
const SUPERSEDED_REFRESH = 'Refresh token was already replaced by a newer one, send that one';
const SESSION_BUSY = 'The session could not be changed in time, try again';
const EMAIL_TAKEN = 'Email is already registered';
const UNIQUE_VIOLATION = '23505';
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), 10);
const ROTATION_RETRY_MS = 10 * 60_000;
export const WS_AUDIENCE = 'ws';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

const SESSION_LOCK_TIMEOUT_MS = 2_000;
const SESSION_STATEMENT_TIMEOUT_MS = 3_000;
const SESSION_CHANGE_BUDGET_MS = 5_000;

interface Superseded {
  superseded: true;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshSession) private readonly sessions: Repository<RefreshSession>,
    private readonly jwt: JwtService,
    private readonly revocations: SessionRevocations,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    const existing = await this.users
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: dto.email })
      .getExists();
    if (existing) {
      throw new ConflictException(EMAIL_TAKEN);
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.users
      .save(this.users.create({ email: dto.email, passwordHash, role: 'user' }))
      .catch((error: unknown) => {
        if (
          error instanceof QueryFailedError &&
          (error.driverError as { code?: string }).code === UNIQUE_VIOLATION
        ) {
          throw new ConflictException(EMAIL_TAKEN);
        }
        throw error;
      });
    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const candidates = await this.users
      .createQueryBuilder('user')
      .where('lower(user.email) = :email', { email: dto.email })
      .getMany();
    candidates.sort((a, b) => Number(b.email === dto.email) - Number(a.email === dto.email));
    let user: User | undefined;
    for (const candidate of candidates.length > 0 ? candidates : [undefined]) {
      const valid = await bcrypt.compare(dto.password, candidate?.passwordHash ?? DUMMY_HASH);
      if (valid && candidate && !user) user = candidate;
    }
    if (!user) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return this.issueTokens(user);
  }

  async isAdmin(userId: string): Promise<boolean> {
    const user = await this.users.findOne({ select: { id: true, role: true }, where: { id: userId } });
    return user?.role === 'admin';
  }

  wsTicket(userId: string, until: number, sessionId?: string): { ticket: string } {
    const ticket = this.jwt.sign(
      { sub: userId, until, ...(sessionId ? { sid: sessionId } : {}) },
      { secret: requireEnv('JWT_ACCESS_SECRET'), audience: WS_AUDIENCE, expiresIn: '30s' },
    );
    return { ticket };
  }

  refresh(refreshToken: string, attempt?: string): Promise<TokenPair> {
    return this.withinBudget((beforeCommit) => this.rotate(refreshToken, attempt, beforeCommit));
  }

  logout(userId: string, sessionId?: string): Promise<void> {
    return this.withinBudget(() => this.endSessions(userId, sessionId));
  }

  private withinBudget<T>(work: (beforeCommit: () => void) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let answered = false;
      let committing = false;
      const timer = setTimeout(() => {
        if (committing) return;
        answered = true;
        reject(new ServiceUnavailableException(SESSION_BUSY));
      }, SESSION_CHANGE_BUDGET_MS);
      const beforeCommit = () => {
        if (answered) throw new ServiceUnavailableException(SESSION_BUSY);
        committing = true;
      };
      work(beforeCommit)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  }

  private async rotate(refreshToken: string, attempt: string | undefined, beforeCommit: () => void): Promise<TokenPair> {
    let claims: { sub?: unknown; jti?: unknown };
    try {
      claims = this.jwt.verify<{ sub?: unknown; jti?: unknown }>(refreshToken, {
        secret: requireEnv('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    const { sub: userId, jti: sessionId } = claims;
    if (typeof userId !== 'string' || !isUUID(userId) || typeof sessionId !== 'string' || !isUUID(sessionId)) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    const outcome = await this.sessions.manager.transaction(async (manager) => {
      await this.lockSessionsOf(manager, userId);
      const session = await manager.findOne(RefreshSession, {
        where: { id: sessionId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session || session.revokedAt || session.tokenHash !== tokenHash(refreshToken)) return null;
      const user = await manager.findOneBy(User, { id: userId });
      if (session.usedAt) {
        if (attempt && this.retriesRotation(session, attempt)) {
          return user ? this.reissue(manager, user, session) : null;
        }
        await manager.update(
          RefreshSession,
          { familyId: session.familyId, revokedAt: IsNull() },
          { revokedAt: () => 'now()' },
        );
        await this.revocations.record(manager, [session.familyId]);
        return { reusedFamily: session.familyId };
      }
      if (!user) return null;
      const successorId = randomUUID();
      await manager.update(
        RefreshSession,
        { id: session.id },
        {
          usedAt: () => 'now()',
          rotationAttempt: attempt ? tokenHash(attempt) : null,
          successorId,
        },
      );
      const pair = await this.openSession(manager, user, session.familyId, successorId);
      beforeCommit();
      return pair;
    });
    if (outcome && 'superseded' in outcome) throw new ConflictException(SUPERSEDED_REFRESH);
    if (outcome && 'reusedFamily' in outcome) {
      await this.revocations.announce([outcome.reusedFamily]);
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    if (!outcome) throw new UnauthorizedException(INVALID_REFRESH);
    return outcome;
  }

  private async endSessions(userId: string, sessionId?: string): Promise<void> {
    const familyId = sessionId && isUUID(sessionId) ? sessionId : undefined;
    const families = await this.sessions.manager.transaction(async (manager) => {
      await this.lockSessionsOf(manager, userId);
      const revoked: { familyId: string }[] = (
        await manager
          .createQueryBuilder()
          .update(RefreshSession)
          .set({ revokedAt: () => 'now()' })
          .where({ userId, ...(familyId ? { familyId } : {}), revokedAt: IsNull() })
          .returning(['familyId'])
          .execute()
      ).raw;
      const families = [...new Set([...(familyId ? [familyId] : []), ...revoked.map((row) => row.familyId)])];
      await this.revocations.record(manager, families);
      return families;
    });
    if (!(await this.revocations.announce(families))) {
      throw new ServiceUnavailableException(
        'The session is ended, but its access token could not be refused yet, sign out again',
      );
    }
  }

  private async lockSessionsOf(manager: EntityManager, userId: string): Promise<void> {
    await manager.query(`SET LOCAL lock_timeout = ${SESSION_LOCK_TIMEOUT_MS}`);
    await manager.query(`SET LOCAL statement_timeout = ${SESSION_STATEMENT_TIMEOUT_MS}`);
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`refresh-sessions:${userId}`]);
  }

  private retriesRotation(session: RefreshSession, attempt: string): boolean {
    return (
      session.successorId !== null &&
      session.rotationAttempt === tokenHash(attempt) &&
      session.usedAt !== null &&
      Date.now() - session.usedAt.getTime() < ROTATION_RETRY_MS
    );
  }

  private async reissue(
    manager: EntityManager,
    user: User,
    session: RefreshSession,
  ): Promise<TokenPair | Superseded | null> {
    const successor = await manager.findOne(RefreshSession, {
      where: { id: session.successorId as string, familyId: session.familyId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!successor || successor.revokedAt) return null;
    if (successor.usedAt) return { superseded: true };
    const issuedAt = Math.floor(successor.createdAt.getTime() / 1000);
    const pair = this.signTokens(user, successor.id, successor.familyId, issuedAt);
    if (successor.tokenHash === tokenHash(pair.refreshToken)) return pair;
    const reissuedAt = Math.floor(Date.now() / 1000);
    const reissued = this.signTokens(user, successor.id, successor.familyId, reissuedAt);
    await manager.update(
      RefreshSession,
      { id: successor.id },
      { tokenHash: tokenHash(reissued.refreshToken), createdAt: new Date(reissuedAt * 1000) },
    );
    return reissued;
  }

  private issueTokens(user: User): Promise<TokenPair> {
    return this.openSession(this.sessions.manager, user, randomUUID());
  }

  private async openSession(
    manager: EntityManager,
    user: User,
    familyId: string,
    id: string = randomUUID(),
  ): Promise<TokenPair> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const pair = this.signTokens(user, id, familyId, issuedAt);
    await manager.insert(RefreshSession, {
      id,
      userId: user.id,
      familyId,
      tokenHash: tokenHash(pair.refreshToken),
      createdAt: new Date(issuedAt * 1000),
    });
    return pair;
  }

  private signTokens(user: User, sessionId: string, familyId: string, issuedAt: number): TokenPair {
    const accessToken = this.jwt.sign(
      { sub: user.id, sid: familyId, email: user.email, role: user.role === 'admin' ? 'admin' : 'user' },
      { secret: requireEnv('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti: sessionId, iat: issuedAt },
      { secret: requireEnv('JWT_REFRESH_SECRET'), expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }
}
