import { IsIn, ValidateBy } from 'class-validator';
import { OrderSide } from '../entities/order.entity';
import { INSTRUMENTS } from '../../common/instruments';
import { IsPositiveDecimal } from '../../common/is-positive-decimal.decorator';
import {
  MAX_ORDER_NOTIONAL,
  PRICE_INTEGER_DIGITS,
  PRICE_SCALE,
  QUANTITY_INTEGER_DIGITS,
  QUANTITY_SCALE,
  notionalFits,
} from '../../common/decimal';

export class SubmitOrderDto {
  @IsIn(INSTRUMENTS)
  instrument: string;

  @IsIn(['buy', 'sell'])
  side: OrderSide;

  @IsPositiveDecimal(PRICE_INTEGER_DIGITS, PRICE_SCALE)
  price: string;

  @IsPositiveDecimal(QUANTITY_INTEGER_DIGITS, QUANTITY_SCALE)
  @ValidateBy({
    name: 'notionalFits',
    validator: {
      validate: (quantity: unknown, args) => notionalFits((args?.object as SubmitOrderDto).price, quantity),
      defaultMessage: () => `price × quantity must not be above ${MAX_ORDER_NOTIONAL}`,
    },
  })
  quantity: string;
}
