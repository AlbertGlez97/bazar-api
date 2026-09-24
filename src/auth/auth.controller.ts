import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service.js';

export class LoginDto {
  @IsString() @Length(1, 100) username!: string;
  @IsString() @Length(1, 256) password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Post('login')
  @ApiExample('login')
  @HttpCode(200)
  login(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: LoginDto,
      }),
    )
    body: LoginDto,
  ) {
    return this.auth.login(body.username, body.password);
  }
}
