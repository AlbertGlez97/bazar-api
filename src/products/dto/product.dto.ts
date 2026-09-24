import {
  IsIn,
  IsInt,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
  IsOptional,
  Matches,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MINOR_UNITS } from '../../common/money.js';
import { ProductPriceDto } from './product-price.dto.js';

export class ProductMetadataDto {
  @IsOptional() @IsString() @Length(1, 100) category?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MINOR_UNITS) purchaseCostMinor?:
    number | null;
  @IsOptional() @IsString() @Length(1, 200) supplier?: string | null;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string | null;
}

export class CreateProductDto extends ProductPriceDto {
  @IsString() @Length(1, 200) @Matches(/\S/) name!: string;
  @ApiProperty({ enum: ['unica', 'cantidad'] })
  @IsIn(['unica', 'cantidad'])
  tipo!: 'unica' | 'cantidad';
  // Required only for tipo 'cantidad'; a 'unica' product is forced to
  // stock 1 by the service regardless of what is sent here (see
  // ProductsService.create), so it stays optional/validated but is never
  // the actual source of truth for a unique piece's stock.
  @ApiProperty({
    required: false,
    description:
      "Required for tipo 'cantidad'. Ignored for tipo 'unica', which is always forced to stock 1 by the server.",
  })
  @ValidateIf(
    (o: CreateProductDto) =>
      o.tipo === 'cantidad' || o.initialStock !== undefined,
  )
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  initialStock?: number;
  @IsOptional() @IsString() @Length(1, 100) category?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MINOR_UNITS) purchaseCostMinor?:
    number | null;
  @IsOptional() @IsString() @Length(1, 200) supplier?: string | null;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string | null;
}

export class PatchProductDto extends ProductMetadataDto {
  // tipo/initialStock/stock are deliberately absent from this DTO: they are
  // immutable after creation (see ProductsService.patch); only whitelisted
  // fields can ever reach the update, regardless of what a client sends.
  @ValidateIf((o: PatchProductDto) => o.name !== undefined)
  @IsString()
  @Length(1, 200)
  @Matches(/\S/)
  name?: string;
  @ValidateIf((o: PatchProductDto) => o.unitPriceMinor !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  unitPriceMinor?: number;
}

export class ProductListDto {
  @IsOptional() @IsString() @Length(0, 200) search?: string;
  // Defaults to hiding deactivated products, since the everyday catalog
  // (sale screen) should never surface something that can no longer be
  // sold; a socio managing the catalog opts in explicitly to see them.
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  // Query strings arrive as text ("true"/"false"), never real booleans;
  // a plain `@Type(() => Boolean)` would coerce the non-empty string
  // "false" to `true`, so the value is parsed explicitly instead.
  @Transform(({ value }) => value === true || value === 'true')
  @IsIn([true, false])
  includeInactive = false;
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
