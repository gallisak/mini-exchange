import { IsISO8601, IsUUID } from 'class-validator';

export class HistoryQueryDto {
  @IsISO8601({ strict: true })
  before: string;

  @IsUUID()
  beforeId: string;
}
