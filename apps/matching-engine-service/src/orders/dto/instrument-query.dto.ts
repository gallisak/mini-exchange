import { IsIn } from 'class-validator';
import { INSTRUMENTS } from '../../common/instruments';

export class InstrumentQueryDto {
  @IsIn(INSTRUMENTS)
  instrument: string;
}
