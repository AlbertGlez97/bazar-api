import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Shown when `correoEnvio` is present but is not an email address. */
export const INVALID_CORREO_ENVIO_MESSAGE =
  'Escribe un correo válido, por ejemplo nombre@dominio.com';

/** Trims surrounding whitespace so "  Tablet  " is stored and shown as typed. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Body of `POST /devices` (socio only). The client never chooses the
 * identifier, the status or any credential: the server generates the one-time
 * identifier and the device starts as `pendiente_activacion`.
 *
 * `name` is trimmed BEFORE validation because it is also what the person must
 * type, exactly, next to the identifier when they activate the device.
 */
export class CreateDeviceDto {
  @Transform(trim) @IsString() @Length(1, 100) @Matches(/\S/) name!: string;

  @ApiProperty({
    required: false,
    description:
      'When present, the one-time identifier is emailed to this address and ' +
      'is NOT returned in the response. When absent, the response carries the ' +
      'identifier so the socio can copy it and share it.',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @Transform(trim)
  @IsEmail({}, { message: INVALID_CORREO_ENVIO_MESSAGE })
  correoEnvio?: string;
}

/** Optional body of `PATCH /devices/:id/reissue`. */
export class ReissueDeviceDto {
  @ApiProperty({
    required: false,
    description:
      'When present, the NEW one-time identifier is emailed to this address ' +
      'and is NOT returned in the response.',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @Transform(trim)
  @IsEmail({}, { message: INVALID_CORREO_ENVIO_MESSAGE })
  correoEnvio?: string;
}

/**
 * Body of `POST /devices/identify`: the one-time activation code and the exact
 * device name, both as the socio created them.
 */
export class IdentifyDeviceDto {
  @ApiProperty({
    description:
      'Activation identifier of the device: one-time for a device created ' +
      'with POST /devices (it stops working once used); the stable ' +
      'identifier of a legacy device (created before BE-12) keeps working. ' +
      'Not the internal device id.',
  })
  @IsString()
  @Length(1, 100)
  identifier!: string;
  @IsString() @Length(1, 100) name!: string;
}
