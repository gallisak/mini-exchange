import { IsISO8601 } from 'class-validator';

export class PeriodQueryDto {
  @IsISO8601({ strict: true })
  from: string;

  @IsISO8601({ strict: true })
  to: string;
}
