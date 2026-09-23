import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_ITEM_QUANTITY } from '../../sales/dto/create-sale.dto.js';

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
}
