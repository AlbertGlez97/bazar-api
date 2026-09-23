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
import { Type } from 'class-transformer';
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
  @IsIn(['unica', 'cantidad']) tipo!: 'unica' | 'cantidad';
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
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
