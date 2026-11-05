import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from '../src/auth/dto/login.dto';
import { RegisterDto } from '../src/auth/dto/register.dto';

const invalidFields = async (type: typeof LoginDto | typeof RegisterDto, password: string) =>
  (await validate(plainToInstance(type, { email: 'trader@example.com', password }))).map(
    (error) => error.property,
  );

describe('password length', () => {
  it.each([RegisterDto, LoginDto])('accepts a password of 72 bytes (%p)', async (type) => {
    await expect(invalidFields(type, 'a'.repeat(72))).resolves.toEqual([]);
  });

  it.each([RegisterDto, LoginDto])(
    'rejects what bcrypt would silently cut at 72 bytes (%p)',
    async (type) => {
      await expect(invalidFields(type, 'a'.repeat(73))).resolves.toEqual(['password']);
      await expect(invalidFields(type, 'ї'.repeat(37))).resolves.toEqual(['password']);
    },
  );
});
