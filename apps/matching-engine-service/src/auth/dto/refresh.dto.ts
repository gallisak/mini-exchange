import { IsJWT, IsOptional, IsUUID } from 'class-validator';

export class RefreshDto {
  @IsJWT()
  refreshToken: string;

  @IsOptional()
  @IsUUID()
  attempt?: string;
}
