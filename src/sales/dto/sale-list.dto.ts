import { IsIn, IsOptional } from 'class-validator';
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
}
