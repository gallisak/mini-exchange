import { IsISO8601, IsOptional } from 'class-validator';

export class ReconciliationQueryDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
