import {
  IsISO8601,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MINOR_UNITS } from '../../common/money.js';

/**
 * A single planned installment for a Deuda (BE-15, D2/D3) — purely
 * informative ("when the debtor said they'd pay each installment"), never
 * itself an Abono and never read by any balance/status calculation (see
 * the `CuotaPlaneada` model's own doc comment in schema.prisma and
 * DeudasService.registerAbono, which only ever sums real Abono rows).
 * Shared shape for `CreateDeudaDto.cuotasPlaneadas[]` (created alongside
 * the Deuda) and `POST /deudas/:id/cuotas` (added afterwards) — both
 * accept exactly the same two fields.
 */
export class CuotaPlaneadaInputDto {
  @ApiProperty({
    description: 'Expected payment calendar day (YYYY-MM-DD).',
    format: 'date',
    example: '2026-10-15',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  fechaEsperada!: string;

  @ApiProperty({ minimum: 1, maximum: MAX_MINOR_UNITS })
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR_UNITS)
  montoEsperadoMinor!: number;
}

/** `POST /deudas/:id/cuotas` body — identical shape to the nested input. */
export class CreateCuotaDto extends CuotaPlaneadaInputDto {}

/**
 * `PATCH /deudas/:id/cuotas/:cuotaId` body — both fields optional (edit
 * either or both); neither field is more "required" than the other for
 * editing an already-existing row, so an empty body is accepted as a
 * no-op rather than rejected.
 */
export class UpdateCuotaDto {
  @ApiProperty({
    required: false,
    description: 'Expected payment calendar day (YYYY-MM-DD).',
    format: 'date',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  fechaEsperada?: string;

  @ApiProperty({ required: false, minimum: 1, maximum: MAX_MINOR_UNITS })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR_UNITS)
  montoEsperadoMinor?: number;
}
