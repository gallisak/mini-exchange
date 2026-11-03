import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsUUID } from 'class-validator';
import { INSTRUMENTS } from '../../common/instruments';
import { IsPositiveDecimal } from '../../common/is-positive-decimal.decorator';
import { DiffersFrom } from '../../common/differs-from.decorator';
import {
  PRICE_INTEGER_DIGITS,
  PRICE_SCALE,
  QUANTITY_INTEGER_DIGITS,
  QUANTITY_SCALE,
} from '../../common/decimal';

const lowerCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class SettleTradeDto {
  @Transform(lowerCase)
  @IsUUID()
  tradeId: string;

  @IsIn(INSTRUMENTS)
  instrument: string;

  @Transform(lowerCase)
  @IsUUID()
  buyOrderId: string;

  @Transform(lowerCase)
  @IsUUID()
  sellOrderId: string;

  @Transform(lowerCase)
  @IsUUID()
  buyerId: string;

  @Transform(lowerCase)
  @IsUUID()
  @DiffersFrom('buyerId')
  sellerId: string;

  @IsPositiveDecimal(PRICE_INTEGER_DIGITS, PRICE_SCALE)
  price: string;

  @IsPositiveDecimal(QUANTITY_INTEGER_DIGITS, QUANTITY_SCALE)
  quantity: string;

  @IsISO8601({ strict: true })
  executedAt: string;
}
