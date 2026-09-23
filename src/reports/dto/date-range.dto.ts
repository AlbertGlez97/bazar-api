import { IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Unlike CommissionsQueryDto, both bounds are required here: reports are
// always for a period a socio explicitly asks about (today, a given day,
// a custom range) rather than defaulting to "the current week" the way a
// commission lookup does.
export class DateRangeQueryDto {
  @ApiProperty({
    description:
      'Range start (date-only, e.g. 2025-01-01, or a full ISO-8601 instant). A date-only value means the start of that local business day.',
  })
  @IsISO8601()
  from!: string;

  @ApiProperty({
    description:
      'Range end (inclusive). A date-only value means the end of that local business day.',
  })
  @IsISO8601()
  to!: string;
}
