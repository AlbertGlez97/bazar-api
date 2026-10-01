import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_ITEM_QUANTITY } from '../../sales/dto/create-sale.dto.js';
import { MAX_MINOR_UNITS } from '../../common/money.js';
import { CuotaPlaneadaInputDto } from './cuota-planeada.dto.js';

/**
 * Inline payload to create a brand-new {@link Deudor} in the same request
 * that creates the Deuda, for the common case of a first-time debtor.
 * Mutually exclusive with `CreateDeudaDto.deudorId` (an existing debtor) —
 * DeudasService rejects a request that supplies both or neither.
 */
export class DeudorInputDto {
  @IsString() @Length(1, 200) nombre!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  telefono?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notas?: string;
}

export class CreateDeudaDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    description:
      'Client-generated retry identity. Reuse only with identical creation input.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  id?: string;

  @ApiProperty({ enum: ['fiado', 'apartado'] })
  @IsIn(['fiado', 'apartado'])
  type!: 'fiado' | 'apartado';

  @IsUUID() productId!: string;

  @IsInt() @Min(1) @Max(MAX_ITEM_QUANTITY) cantidad!: number;

  // Exactly one of deudorId/deudor must be supplied (validated in
  // DeudasService, not here, since class-validator's cross-field
  // mutual-exclusion decorators are awkward to read compared to a plain
  // explicit check against the parsed DTO).
  @ApiProperty({
    required: false,
    description:
      'Existing Deudor id. Mutually exclusive with `deudor` (which creates a new one).',
  })
  @IsOptional()
  @IsUUID()
  deudorId?: string;

  @ApiProperty({
    required: false,
    type: DeudorInputDto,
    description:
      'Inline data to create a new Deudor. Mutually exclusive with `deudorId`.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeudorInputDto)
  deudor?: DeudorInputDto;

  // BE-15 (D1): required (not optional), specifically so the caller must
  // always be explicit about it — `0` is a valid, deliberate "no initial
  // payment", never a silently-omitted default. When > 0, DeudasService
  // creates the first Abono inside the same transaction that creates the
  // Deuda, reusing registerAbono's own "cannot exceed totalMinor" guard.
  @ApiProperty({
    minimum: 0,
    maximum: MAX_MINOR_UNITS,
    description:
      'Initial payment collected at creation time, in minor units. Always required — send 0 for "no initial payment". Creates the first Abono (dated today) in the same transaction when > 0; rejected if it alone would exceed totalMinor.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  abonoInicialMinor!: number;

  // BE-15 (D3): optional payment schedule created alongside the Deuda, in
  // the same transaction. Purely informative — see CuotaPlaneadaInputDto's
  // own doc comment.
  @ApiProperty({
    required: false,
    type: [CuotaPlaneadaInputDto],
    description:
      'Optional planned payment schedule, created in the same transaction as the Deuda.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CuotaPlaneadaInputDto)
  cuotasPlaneadas?: CuotaPlaneadaInputDto[];
}
