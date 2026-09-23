import { IsInt, Max, Min } from 'class-validator';
import { MAX_MINOR_UNITS } from '../../common/money.js';

// Prices cross the API boundary as nonnegative integer cents.
export class ProductPriceDto {
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  unitPriceMinor!: number;
}
