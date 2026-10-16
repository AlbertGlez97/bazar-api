import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';
import { cleanText } from '../../common/text-sanitize.js';
import { INVALID_CORREO_MESSAGE } from './create-business-registration.dto.js';

/** Body of POST /business-registration/resend. The answer is always generic. */
export class ResendVerificationDto {
  @Transform(({ value }: { value: unknown }) => cleanText(value))
  @IsEmail({}, { message: INVALID_CORREO_MESSAGE })
  correo!: string;
}
