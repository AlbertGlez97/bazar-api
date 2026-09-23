import { Type } from 'class-transformer';
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

  @ApiProperty({ required: false, enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort: 'asc' | 'desc' = 'desc';

  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
