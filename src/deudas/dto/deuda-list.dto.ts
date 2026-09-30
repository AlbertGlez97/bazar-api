import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeudaListDto {
  @ApiProperty({
    required: false,
    enum: ['pendiente', 'saldada'],
    description:
      'Filters the listing to a single status. Omit to list all statuses — most commonly used as status=pendiente, "who currently owes money".',
  })
  @IsOptional()
  @IsIn(['pendiente', 'saldada'])
  status?: 'pendiente' | 'saldada';

  // Matches against the Deudor's own name (case-insensitive) — unlike
  // Sale/Incidencia listings, which search the *selling* Member's name,
  // a socio reviewing deudas thinks in terms of "who owes", i.e. the
  // customer, not who rang up the fiado/apartado.
  @ApiProperty({
    required: false,
    description: "Case-insensitive search on the Deudor's name.",
  })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;

  // BE-15 (D6): which field to order by. `createdAt` (default) keeps the
  // original DB-level orderBy+skip/take (fast path). `saldoPendiente` and
  // `cuotaVencida` are computed fields (never stored columns), so those
  // two force DeudasService.list into an in-memory fetch-all/compute/
  // sort/paginate path instead — documented there, not duplicated here.
  @ApiProperty({
    required: false,
    enum: ['createdAt', 'saldoPendiente', 'cuotaVencida'],
    default: 'createdAt',
    description:
      '`saldoPendiente`: always descending (most owed first), ignores `sort`. ' +
      '`cuotaVencida`: earliest overdue CuotaPlaneada.fechaEsperada first (ascending); a Deuda with no overdue cuota sorts last, ignores `sort`.',
  })
  @IsOptional()
  @IsIn(['createdAt', 'saldoPendiente', 'cuotaVencida'])
  orderBy: 'createdAt' | 'saldoPendiente' | 'cuotaVencida' = 'createdAt';

  @ApiProperty({
    required: false,
    enum: ['asc', 'desc'],
    default: 'desc',
    description: 'Only applies when `orderBy` is `createdAt` (the default).',
  })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort: 'asc' | 'desc' = 'desc';

  // BE-15 (D6): server-computed — true when this Deuda has at least one
  // CuotaPlaneada whose fechaEsperada is already past AND the sum of
  // overdue CuotaPlaneada.montoEsperadoMinor exceeds the sum of real
  // Abono.montoMinor so far. Omit for no filter; computed in application
  // code (DeudasService.list), never a raw SQL expression — see there for
  // why.
  @ApiProperty({
    required: false,
    description:
      'Filters to Deudas that are (true) or are not (false) atrasado. Omit for no filter.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined) return undefined;
    return value === true || value === 'true';
  })
  @IsIn([true, false])
  atrasado?: boolean;

  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
