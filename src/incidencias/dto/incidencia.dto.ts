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

export class IncidenciaListDto {
  @ApiProperty({
    required: false,
    enum: ['conflicto_stock', 'incidencia_fecha'],
  })
  @IsOptional()
  @IsIn(['conflicto_stock', 'incidencia_fecha'])
  type?: 'conflicto_stock' | 'incidencia_fecha';

  @ApiProperty({
    required: false,
    enum: ['pendiente', 'resuelta'],
    description: 'Defaults to listing every resolutionStatus when omitted.',
  })
  @IsOptional()
  @IsIn(['pendiente', 'resuelta'])
  resolutionStatus?: 'pendiente' | 'resuelta';

  // Matches the name of the Member who *sold* the related Sale — the
  // person a socio would actually recognize and ask about the incidencia
  // — not the (possibly still-empty) resolvedBy Member.
  @ApiProperty({
    required: false,
    description:
      "Case-insensitive search on the related Sale's selling Member name.",
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

export class ResolveIncidenciaDto {
  @ApiProperty({
    description:
      'Free-text notes on what was agreed with the customer/decided internally. Required so a resolved incidencia always documents why.',
  })
  @IsString()
  @Length(1, 2000)
  resolutionNotes!: string;
}
