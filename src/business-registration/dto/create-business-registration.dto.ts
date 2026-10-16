import { Transform } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { cleanText } from '../../common/text-sanitize.js';
import { BUSINESS_TYPES, type BusinessTypeValue } from '../business-type.js';
import { normalizeMexicanPhone } from '../phone.js';

/** Shown to the person filling the form when the correo is not an email. */
export const INVALID_CORREO_MESSAGE =
  'Escribe un correo válido, por ejemplo nombre@dominio.com';
export const INVALID_TELEFONO_MESSAGE =
  'Escribe un teléfono de 10 dígitos, por ejemplo 55 1234 5678';

/** Texto libre NO CONFIABLE: limpio (sin control ni invisibles) antes de validar. */
const clean = ({ value }: { value: unknown }): unknown => cleanText(value);

/** Igual que `clean`, pero un valor vacío de un campo opcional cuenta como "no vino". */
const cleanOptional = ({ value }: { value: unknown }): unknown => {
  const cleaned = cleanText(value);
  return cleaned === '' ? undefined : cleaned;
};

/** "2026-10-16": una fecha de calendario real en ese formato. */
@ValidatorConstraint({ name: 'isLegalVersion', async: false })
class IsLegalVersion implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }
  defaultMessage(): string {
    return 'versionLegal debe ser una fecha AAAA-MM-DD';
  }
}

/**
 * Public "register my business" form. No auth: it is the entry point for a business that
 * does not exist in this system yet. The request is created as "pendiente_correo" and the
 * approver hears nothing until the applicant confirms the emailed link.
 *
 * Every text is UNTRUSTED: it is cleaned here (no control or invisible characters, repeated
 * spaces collapsed) and limited in length, and it is HTML-escaped wherever it is shown.
 * The correo is only checked for FORMAT; the emailed link is what proves the mailbox is theirs.
 * The telefono is NOT verified (no codes, no paid services): it is saved as 10 digits and the
 * approver writes to that WhatsApp number.
 *
 * `turnstileToken` is Cloudflare Turnstile's one-use token, checked on the server.
 * `sitioWebEmpresa` is a honeypot: people never see it, bots fill it. It is accepted (so the
 * bot gets no hint) and the service answers as if everything went well, creating nothing.
 *
 * No `@ApiProperty()` here, matching the project's Swagger convention (see
 * `src/docs/operation-examples.ts`, `businessRegistrationCreate`).
 */
export class CreateBusinessRegistrationDto {
  @Transform(clean) @IsString() @Length(1, 200) @Matches(/\S/) nombreNegocio!: string;
  @IsIn(BUSINESS_TYPES) tipoNegocio!: BusinessTypeValue;
  @Transform(clean) @IsString() @Length(10, 400) queVende!: string;
  @IsOptional()
  @Transform(cleanOptional)
  @IsString()
  @Length(1, 200)
  dondeVende?: string;
  @IsOptional()
  @Transform(cleanOptional)
  @IsString()
  @Length(1, 120)
  recomendadoPor?: string;
  @Transform(clean) @IsString() @Length(1, 100) @Matches(/\S/) nombre!: string;
  @Transform(clean) @IsString() @Length(1, 100) @Matches(/\S/) apellidos!: string;
  // `@IsEmail()` already rejects an address over 254 characters (the practical
  // maximum of RFC 5321), so a missing, blank, malformed OR over-long correo all
  // get this one message.
  @Transform(clean)
  @IsEmail({}, { message: INVALID_CORREO_MESSAGE })
  correo!: string;
  // Normalized to 10 digits BEFORE validating; anything that is not a Mexican phone keeps
  // its original value and fails the pattern with the friendly message.
  @Transform(({ value }: { value: unknown }) => normalizeMexicanPhone(value) ?? value)
  @Matches(/^[2-9]\d{9}$/, { message: INVALID_TELEFONO_MESSAGE })
  telefono!: string;
  @Equals(true, { message: 'Debes aceptar el Aviso de privacidad y los Términos' })
  aceptaLegal!: boolean;
  @Validate(IsLegalVersion) versionLegal!: string;
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 2048)
  turnstileToken!: string;
  @IsOptional() @IsString() @Length(0, 500) sitioWebEmpresa?: string;
}
