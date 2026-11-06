import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { User } from '../src/auth/entities/user.entity';
import { RefreshSession } from '../src/auth/entities/refresh-session.entity';

jest.mock('bcrypt', () => {
  const actual = jest.requireActual('bcrypt');
  return { ...actual, compare: jest.fn(actual.compare) };
});

describe('login', () => {
  it('checks a password hash even for an unknown email, so timing does not reveal accounts', async () => {
    const users = {
      createQueryBuilder: () => ({
        where: () => ({ getMany: async () => [] }),
      }),
    } as unknown as Repository<User>;
    const service = new AuthService(users, {} as Repository<RefreshSession>, new JwtService(), {} as never);

    await expect(
      service.login({ email: 'nobody@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
  });
});
