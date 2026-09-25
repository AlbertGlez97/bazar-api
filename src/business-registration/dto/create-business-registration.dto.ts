import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';

/** Shown to the person filling the form when the correo is not an email. */
export const INVALID_CORREO_MESSAGE =
  'Escribe un correo válido, por ejemplo nombre@dominio.com';

/** Trims surrounding whitespace so "  ana@x.com " and "   " behave sensibly. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Public "register my business" form (BE-11). No auth: this is the entry
 * point for a business that does not exist in this system yet.
 *
 * The founding socio is described by real fields, not free text:
 * `nombre` + `apellidos`, a `correo` (a real email: the credentials are
 * emailed there once the request is approved) and an optional `telefono`. `telefono` has no
 * strict format on purpose (international numbers, extensions...): it is
 * only 1..30 characters and never blank when present. `null` is not
 * accepted for it: leave the field out.
 *
 * The correo is only checked for FORMAT (`@IsEmail()`, at most 254
 * characters): whether the mailbox really exists is deliberately not
 * verified (no third-party verification service), so the credentials email
 * may still bounce for a well-formed but non-existent address.
 *
 * `nombre`, `apellidos`, `correo` and `telefono` are trimmed BEFORE they are
 * validated, so a value made only of spaces counts as blank (400).
 *
 * No `@ApiProperty()` here, matching this project's established Swagger
 * convention: plain required strings with no extra semantics (no enum,
 * no `required: false`, no bespoke description) are already inferred by
 * `@nestjs/swagger` from the `class-validator` decorators' emitted type
 * metadata. The full request example/description lives in
 * `src/docs/operation-examples.ts` (`businessRegistrationCreate`),
 * consumed via `@ApiExample` on the controller, same as every other
 * module's DTOs.
 */
export class CreateBusinessRegistrationDto {
  @IsString() @Length(1, 200) @Matches(/\S/) nombreNegocio!: string;
  @Transform(trim) @IsString() @Length(1, 100) @Matches(/\S/) nombre!: string;
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  @Matches(/\S/)
  apellidos!: string;
  // `@IsEmail()` already rejects an address over 254 characters (the practical
  // maximum of RFC 5321), so a missing, blank, malformed OR over-long correo all
  // get this one message. A separate `@MaxLength` would also fire for a MISSING
  // correo (not a string) and tell the user it is "too long".
  @Transform(trim)
  @IsEmail({}, { message: INVALID_CORREO_MESSAGE })
  correo!: string;
  @ValidateIf((_dto, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 30)
  telefono?: string;
}
