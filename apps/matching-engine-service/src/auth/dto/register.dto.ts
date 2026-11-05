import { Transform } from 'class-transformer';
import { IsEmail, MinLength } from 'class-validator';
import { MaxBytes } from '../../common/max-bytes.decorator';
import { PASSWORD_MAX_BYTES } from '../password';

export class RegisterDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;

  @MinLength(8)
  @MaxBytes(PASSWORD_MAX_BYTES)
  password: string;
}
