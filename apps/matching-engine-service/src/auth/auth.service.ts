import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
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

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const INVALID_CREDENTIALS = 'Invalid email or password';
const INVALID_REFRESH = 'Refresh token is invalid or was already used';
const EMAIL_TAKEN = 'Email is already registered';
const UNIQUE_VIOLATION = '23505';
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), 10);

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshSession) private readonly sessions: Repository<RefreshSession>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    const existing = await this.users.findOne({ where: { email: dto.email } });
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
    const user = await this.users.findOne({ where: { email: dto.email } });
    const valid = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
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
    const pair = await this.sessions.manager.transaction(async (manager) => {
      const session = await manager.findOne(RefreshSession, {
        where: { id: sessionId, userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session || session.revokedAt || session.tokenHash !== tokenHash(refreshToken)) return null;
      if (session.usedAt) {
        await manager.update(
          RefreshSession,
          { familyId: session.familyId, revokedAt: IsNull() },
          { revokedAt: () => 'now()' },
        );
        return null;
      }
      const user = await manager.findOneBy(User, { id: userId });
      if (!user) return null;
      await manager.update(RefreshSession, { id: session.id }, { usedAt: () => 'now()' });
      return this.openSession(manager, user, session.familyId);
    });
    if (!pair) throw new UnauthorizedException(INVALID_REFRESH);
    return pair;
  }

  async logout(userId: string): Promise<void> {
    await this.sessions.update({ userId, revokedAt: IsNull() }, { revokedAt: () => 'now()' });
  }

  private issueTokens(user: User): Promise<TokenPair> {
    return this.openSession(this.sessions.manager, user, randomUUID());
  }

  private async openSession(manager: EntityManager, user: User, familyId: string): Promise<TokenPair> {
    const id = randomUUID();
    const pair = this.signTokens(user, id);
    await manager.insert(RefreshSession, {
      id,
      userId: user.id,
      familyId,
      tokenHash: tokenHash(pair.refreshToken),
    });
    return pair;
  }

  private signTokens(user: User, sessionId: string): TokenPair {
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email, role: user.role === 'admin' ? 'admin' : 'user' },
      { secret: requireEnv('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti: sessionId },
      { secret: requireEnv('JWT_REFRESH_SECRET'), expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }
}
