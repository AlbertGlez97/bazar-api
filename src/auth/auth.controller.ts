import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';

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

  /**
   * Any logged-in person changes their own password. Only `AuthGuard` runs:
   * no member/device selection is required (see `AuthService.changePassword`).
   */
  @Post('change-password')
  @ApiExample('changePassword')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: ChangePasswordDto,
      }),
    )
    body: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(
      request.account.id,
      body.currentPassword,
      body.newPassword,
    );
  }
}
