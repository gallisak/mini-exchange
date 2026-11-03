import { IsIn } from 'class-validator';
import { OrderSide } from '../entities/order.entity';
import { INSTRUMENTS } from '../../common/instruments';
import { IsPositiveDecimal } from '../../common/is-positive-decimal.decorator';
import {
  PRICE_INTEGER_DIGITS,
  PRICE_SCALE,
  QUANTITY_INTEGER_DIGITS,
  QUANTITY_SCALE,
} from '../../common/decimal';

export class SubmitOrderDto {
  @IsIn(INSTRUMENTS)
  instrument: string;

  @IsIn(['buy', 'sell'])
  side: OrderSide;

  @IsPositiveDecimal(PRICE_INTEGER_DIGITS, PRICE_SCALE)
  price: string;

  @IsPositiveDecimal(QUANTITY_INTEGER_DIGITS, QUANTITY_SCALE)
  quantity: string;
}
