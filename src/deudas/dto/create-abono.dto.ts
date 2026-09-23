import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MAX_MINOR_UNITS } from '../../common/money.js';

export class CreateAbonoDto {
  @IsInt() @Min(1) @Max(MAX_MINOR_UNITS) montoMinor!: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  nota?: string;
}
