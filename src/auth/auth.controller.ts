import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AuthService } from './auth.service.js';

export class LoginDto {
  @IsString() @Length(1, 100) username!: string;
  @IsString() @Length(1, 256) password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Post('login')
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
