import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DashboardQueryDto {
  // No natural business maximum exists for a stock threshold (unlike
  // page/limit, which cap against runaway pagination); 100_000 is simply a
  // generous ceiling to reject obvious garbage input rather than an
  // enforced business rule.
  @ApiProperty({
    required: false,
    default: 2,
    minimum: 0,
    maximum: 100_000,
    description:
      'Stock threshold (inclusive) for "productos con poca existencia".',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  umbral = 2;
}
