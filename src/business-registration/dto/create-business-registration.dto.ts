import { IsString, Length, Matches } from 'class-validator';

/**
 * Public "register my business" form (BE-11). No auth: this is the entry
 * point for a business that does not exist in this system yet.
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
  @IsString() @Length(1, 200) @Matches(/\S/) nombreSocio!: string;
  // Deliberately a free-text contact (email or phone), not @IsEmail(): the
  // task allows either, and validating format beyond "non-empty" would
  // reject legitimate phone numbers.
  @IsString() @Length(1, 200) @Matches(/\S/) contactoSocio!: string;
}
