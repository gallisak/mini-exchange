import { Transform } from 'class-transformer';
import { IsEmail, IsString } from 'class-validator';
import { MaxBytes } from '../../common/max-bytes.decorator';
import { PASSWORD_MAX_BYTES } from '../password';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email: string;

  @IsString()
  @MaxBytes(PASSWORD_MAX_BYTES)
  password: string;
}
