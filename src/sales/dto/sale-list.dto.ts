import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

// Kept as a plain string literal union (matching CreateSaleDto.currency's
// pattern) rather than importing the generated Prisma enum at the DTO
// boundary, so validation error messages stay stable even if the enum's
// internal representation changes.
export class SaleListDto {
  // Absent means "no filter" (all statuses); the manual-review workflow
  // (GET /sales?status=rechazada_por_conflicto) is additive to, not a
  // replacement for, browsing every sale.
  @ApiProperty({
    required: false,
    enum: ['completada', 'rechazada_por_conflicto'],
    description:
      'Filters the listing to a single status, e.g. rechazada_por_conflicto for pending manual review. Omit to list all statuses.',
  })
  @IsOptional()
  @IsIn(['completada', 'rechazada_por_conflicto'])
  status?: 'completada' | 'rechazada_por_conflicto';

  // Matches against the selling Member's name (case-insensitive), not any
  // field on Sale itself — a socio reviewing "movimientos" thinks in terms
  // of "who sold this", not the sale's own id/currency.
  @ApiProperty({
    required: false,
    description: "Case-insensitive search on the selling Member's name.",
  })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;

  @ApiProperty({ required: false, enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort: 'asc' | 'desc' = 'desc';

  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
