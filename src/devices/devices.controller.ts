import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { DevicesService } from './devices.service.js';
import {
  CreateDeviceDto,
  IdentifyDeviceDto,
  ReissueDeviceDto,
} from './dto/device.dto.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * Device management with one-time activation (BE-12).
 *
 * `identify` is the only route open to any authenticated account (a person
 * activating a new device is not a socio yet on that device): it needs the
 * login for the tenant context, not a member/device selection. Creating,
 * listing, revoking and reissuing devices are socio-only ({@link SocioGuard}).
 * Devices are never self-registered: a socio creates them first.
 */
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(
    @Inject(DevicesService) private readonly devices: DevicesService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a device with a one-time activation identifier',
    description:
      'Socio only. The device starts as pendiente_activacion with a fresh ' +
      'one-time identifier. With correoEnvio the identifier is emailed and ' +
      'NOT returned (deliveredTo says where it went); without it the ' +
      'response carries the identifier to copy and share. 502 (and nothing ' +
      'created) when the email cannot be delivered.',
  })
  @UseGuards(SocioGuard)
  create(
    @Req() request: AuthenticatedRequest,
    @Body(validate(CreateDeviceDto)) dto: CreateDeviceDto,
  ) {
    return this.devices.create(request, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List the devices of the business',
    description:
      'Socio only. Status pendiente_activacion | activo | revocado, and ' +
      'legacy=true for an active device that still authenticates with ' +
      'x-device-id alone. The identifier appears only while it is an ' +
      'unconsumed activation code; no token or hash is ever returned.',
  })
  @UseGuards(SocioGuard)
  list(@Req() request: AuthenticatedRequest) {
    return this.devices.list(request.account.contextId);
  }

  @Post('identify')
  @ApiExample('device')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  identify(
    @Req() request: AuthenticatedRequest,
    @Body(validate(IdentifyDeviceDto)) body: IdentifyDeviceDto,
  ) {
    return this.devices.identify(request, body);
  }

  @Patch(':id/revoke')
  @ApiOperation({
    summary: 'Revoke a device',
    description:
      'Socio only. The device stops operating on its very next request. ' +
      'Idempotent. 404 for a device of another business.',
  })
  @UseGuards(SocioGuard)
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.devices.revoke(request, id);
  }

  @Patch(':id/reissue')
  @ApiOperation({
    summary: 'Reissue a one-time activation identifier for a device',
    description:
      'Socio only. Back to pendiente_activacion with a NEW identifier; the ' +
      'old token and identifier stop working immediately. Works on active, ' +
      'legacy and revoked devices. Optional correoEnvio, as in POST /devices. ' +
      '404 for a device of another business.',
  })
  @UseGuards(SocioGuard)
  reissue(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(ReissueDeviceDto)) dto: ReissueDeviceDto,
  ) {
    return this.devices.reissue(request, id, dto);
  }
}
