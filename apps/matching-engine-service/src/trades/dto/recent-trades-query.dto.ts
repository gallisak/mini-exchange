import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { INSTRUMENTS } from '../../common/instruments';

export class RecentTradesQueryDto {
  @IsIn(INSTRUMENTS)
  instrument: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
