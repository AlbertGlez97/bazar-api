import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { PrismaService } from '../database/prisma.service.js';

export class IdentifyDeviceDto {
  @IsString() @Length(1, 100) identifier!: string;
  @IsString() @Length(1, 100) name!: string;
}

/**
 * Resolves a device's stable `identifier` (assigned out-of-band, currently
 * via seed) to its internal id, so the frontend can then send that id as
 * `x-device-id` on every request. Devices are never self-registered here:
 * a device must already exist and be `authorized` in this context, so lost
 * or compromised devices can be revoked centrally without depending on the
 * device itself to stop presenting its old credentials.
 */
@Controller('devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  @Post('identify')
  @HttpCode(200)
  async identify(
    @Req() request: AuthenticatedRequest,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        expectedType: IdentifyDeviceDto,
      }),
    )
    body: IdentifyDeviceDto,
  ) {
    const device = await this.prisma.device.findFirst({
      where: {
        identifier: body.identifier,
        name: body.name,
        contextId: request.account.contextId,
        authorized: true,
      },
      select: { id: true },
    });
    if (!device)
      throw new ForbiddenException('Device is unknown or unauthorized');
    return { deviceId: device.id };
  }
}
