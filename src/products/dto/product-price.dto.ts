import { IsInt, Max, Min } from 'class-validator';
import { MAX_MINOR_UNITS } from '../../common/money.js';

// Monetary input contract only; no product endpoint is introduced in BE-02.
export class ProductPriceDto {
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  salePriceMinor!: number;
}
