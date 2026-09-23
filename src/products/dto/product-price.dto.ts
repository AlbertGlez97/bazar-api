import { IsInt, Max, Min } from 'class-validator';
import { MAX_MINOR_UNITS } from '../../common/money.js';

// Prices cross the API boundary as nonnegative integer cents. @IsInt()
// rejects a decimal like 125.5 at the boundary rather than silently
// truncating or rounding it into a wrong amount.
export class ProductPriceDto {
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  unitPriceMinor!: number;
}
