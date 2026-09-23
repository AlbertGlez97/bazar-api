import { IsInt, Max, Min } from 'class-validator';
import { MAX_MINOR_UNITS } from '../../common/money.js';

// Monetary input contract only; no sale calculation or endpoint is introduced.
export class SalePaymentDto {
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  cashReceivedMinor!: number;
}
