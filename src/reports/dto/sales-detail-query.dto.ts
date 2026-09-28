import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DateRangeQueryDto } from './date-range.dto.js';

// Same page/limit pattern as ProductListDto/SaleListDto/DeudaListDto: page
// starts at 1 (capped high, mostly to reject nonsense rather than to expect
// that many pages), limit capped at 100 per page.
export class SalesDetailQueryDto extends DateRangeQueryDto {
  @ApiProperty({ required: false, default: 1, minimum: 1, maximum: 1_000_000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page = 1;

  @ApiProperty({ required: false, default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
