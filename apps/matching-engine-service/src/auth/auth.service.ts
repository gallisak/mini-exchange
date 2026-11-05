import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { User } from './entities/user.entity';
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
    let userId: string;
    try {
      ({ sub: userId } = this.jwt.verify<{ sub: string }>(refreshToken, {
        secret: requireEnv('JWT_REFRESH_SECRET'),
      }));
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    const pair = this.signTokens(user);
    const rotated = await this.users.update(
      { id: user.id, refreshTokenHash: tokenHash(refreshToken) },
      { refreshTokenHash: tokenHash(pair.refreshToken) },
    );
    if (rotated.affected === 0) {
      await this.users.update({ id: user.id }, { refreshTokenHash: null });
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    return pair;
  }

  async logout(userId: string): Promise<void> {
    await this.users.update({ id: userId }, { refreshTokenHash: null });
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    const pair = this.signTokens(user);
    await this.users.update({ id: user.id }, { refreshTokenHash: tokenHash(pair.refreshToken) });
    return pair;
  }

  private signTokens(user: User): TokenPair {
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email, role: user.role === 'admin' ? 'admin' : 'user' },
      { secret: requireEnv('JWT_ACCESS_SECRET'), expiresIn: '15m' },
    );
    const refreshToken = this.jwt.sign(
      { sub: user.id, jti: randomUUID() },
      { secret: requireEnv('JWT_REFRESH_SECRET'), expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }
}
