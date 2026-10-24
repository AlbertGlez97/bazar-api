import {
  IsBoolean,
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
import { applyDecorators } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MINOR_UNITS } from '../../common/money.js';
import { cleanText } from '../../common/text-sanitize.js';
import { ProductPriceDto } from './product-price.dto.js';

/** Largest sizes of the optional descriptive fields (brand, presentation, description). */
export const MAX_BRAND_LENGTH = 40;
export const MAX_PRESENTATION_LENGTH = 40;
export const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Optional short text a person types: cleaned with the shared sanitizer (control
 * and invisible characters out, line breaks as a space, inner spaces collapsed,
 * trimmed) and an empty result becomes `null`. `null` means "no value": on create
 * it stores nothing and on edit it clears the field; `undefined` (field absent)
 * leaves it untouched. Anything that is not text is left as is for `@IsString`.
 */
const toShortText = ({ value }: { value: unknown }) => {
  const cleaned = cleanText(value);
  return cleaned === '' ? null : cleaned;
};

function ShortText(maxLength: number, description?: string) {
  return applyDecorators(
    ApiProperty({ required: false, nullable: true, maxLength, description }),
    IsOptional(),
    Transform(toShortText),
    IsString(),
    Length(1, maxLength),
  );
}

/** Same cleaning for a filter: an empty value is "no filter", never "only without a value". */
const toShortTextFilter = ({ value }: { value: unknown }) => {
  const cleaned = cleanText(value);
  return cleaned === '' ? undefined : cleaned;
};

/**
 * Query strings arrive as text. `'true'`/`'false'` become real booleans and
 * an empty/whitespace value becomes `undefined` (absent, for `@IsOptional`);
 * anything else is passed through unchanged so `@IsBoolean` rejects it with
 * a 400 instead of silently coercing it.
 */
function toOptionalBoolean(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return value;
}

export class ProductMetadataDto {
  @IsOptional() @IsString() @Length(1, 100) category?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_MINOR_UNITS) purchaseCostMinor?:
    number | null;
  @IsOptional() @IsString() @Length(1, 200) supplier?: string | null;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string | null;
  @ShortText(MAX_BRAND_LENGTH) brand?: string | null;
  @ShortText(
    MAX_PRESENTATION_LENGTH,
    'Size, measure or capacity ("XL", "24 oz"); the color goes inside ("Azul · 28").',
  )
  presentation?: string | null;
  @ShortText(MAX_DESCRIPTION_LENGTH) description?: string | null;
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
  // Mandatory on create (BE-13): the profit reports/dashboard can never
  // estimate a missing cost, so every new product must carry one from the
  // start. Editing an existing product still allows omitting the field
  // (see PatchProductDto/ProductMetadataDto) or leaving it untouched;
  // ProductsService.mutate() separately rejects clearing a cost that was
  // already set.
  @IsInt() @Min(0) @Max(MAX_MINOR_UNITS) purchaseCostMinor!: number;
  @IsOptional() @IsString() @Length(1, 200) supplier?: string | null;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string | null;
  @ShortText(MAX_BRAND_LENGTH) brand?: string | null;
  @ShortText(
    MAX_PRESENTATION_LENGTH,
    'Size, measure or capacity ("XL", "24 oz"); the color goes inside ("Azul · 28").',
  )
  presentation?: string | null;
  @ShortText(MAX_DESCRIPTION_LENGTH) description?: string | null;
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

/** Blank text is "not provided": trimmed, and an empty result becomes absent. */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export class RestockProductDto {
  @ApiProperty({
    minimum: 1,
    description: 'Pieces to ADD to the stock (not the new total).',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_MINOR_UNITS)
  quantity!: number;
  @ApiProperty({
    required: false,
    minimum: 0,
    description:
      'Unit cost of this purchase in cents. Empty leaves the product cost untouched; ' +
      'otherwise the product cost becomes the weighted average (see ProductsService.restock).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR_UNITS)
  unitCostMinor?: number | null;
  @ApiProperty({ required: false, maxLength: 1000 })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, 1000)
  note?: string | null;
}

export class ProductListDto {
  @IsOptional() @IsString() @Length(0, 200) search?: string;
  @ApiProperty({
    required: false,
    maxLength: MAX_BRAND_LENGTH,
    description:
      'Only products of this brand (exact match, ignoring upper/lower case). Omit or leave empty for no filter.',
  })
  @IsOptional()
  @Transform(toShortTextFilter)
  @IsString()
  @Length(1, MAX_BRAND_LENGTH)
  brand?: string;
  // Same param name/semantics as GET /dashboard/summary's own `umbral`
  // (dashboard-query.dto.ts): stock <= umbral, 0..100_000. Deliberately NO
  // default here (unlike the dashboard's default of 2) — absent must mean
  // "no filter" for the everyday catalog listing, not "silently filter at
  // 2". Only the frontend decides to send a threshold when its low-stock
  // toggle is on.
  @ApiProperty({
    required: false,
    minimum: 0,
    maximum: 100_000,
    description:
      'Stock threshold (inclusive): only products with stock <= umbral. ' +
      'No default — omit for the unfiltered catalog.',
  })
  // `@Type(() => Number)` coerces primitives in its own pass, unconditionally
  // AFTER any `@Transform` — so `Number('')` (which is 0, not NaN) would
  // still land regardless of decorator order, silently filtering to stock
  // <= 0 instead of leaving the catalog unfiltered. A single custom
  // `@Transform` doing the whole conversion (empty/whitespace -> undefined,
  // for @IsOptional to treat as absent; anything else must look like a
  // plain decimal integer, so '0x10'/'1e2'/'1.5' fail @IsInt as NaN rather
  // than silently coercing) replaces @Type here entirely.
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  })
  @IsInt()
  @Min(0)
  @Max(100_000)
  umbral?: number;
  // Defaults to hiding deactivated products, since the everyday catalog
  // (sale screen) should never surface something that can no longer be
  // sold. Only honored when the caller's account belongs to an active
  // socio (see ProductsService.list) — silently ignored otherwise, not
  // rejected.
  @ApiProperty({
    required: false,
    default: false,
    description:
      'Also include deactivated products. Only takes effect when the ' +
      'account belongs to an active socio; ignored otherwise.',
  })
  @IsOptional()
  // Query strings arrive as text ("true"/"false"), never real booleans;
  // a plain `@Type(() => Boolean)` would coerce the non-empty string
  // "false" to `true`, so the value is parsed explicitly instead.
  @Transform(({ value }) => value === true || value === 'true')
  @IsIn([true, false])
  includeInactive = false;
  // Catalog filters (panel "Filtros" of the Productos screen). Like `umbral`
  // they have NO default: absent means "no filter", and an explicit `false`
  // is the same as absent (it never means "only products that are in stock /
  // have a cost"). They combine with each other and with `umbral`/`search`.
  @ApiProperty({
    required: false,
    description:
      'Only out-of-stock products (stock = 0). `false` or omitted: no filter.',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  agotados?: boolean;
  @ApiProperty({
    required: false,
    description:
      'Only products without a purchase cost (purchaseCostMinor is null). `false` or omitted: no filter.',
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalBoolean(value))
  @IsBoolean()
  sinCosto?: boolean;
  @ApiProperty({
    required: false,
    enum: ['unica', 'cantidad'],
    description: 'Only products of this tipo. Omit for both.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(['unica', 'cantidad'])
  tipo?: 'unica' | 'cantidad';
  @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}
