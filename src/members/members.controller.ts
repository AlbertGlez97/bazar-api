import { ApiExample } from '../docs/api-example.decorator.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { SocioGuard } from '../auth/socio.guard.js';
import { CommissionsService } from '../commissions/commissions.service.js';
import { SetMemberCommissionRateDto } from '../commissions/dto/commission.dto.js';
import { MembersService } from './members.service.js';
import {
  CreateMemberDto,
  MemberListDto,
  PatchMemberDto,
} from './dto/member.dto.js';

const validate = (expectedType: new () => object) =>
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    expectedType,
  });

/**
 * `list` is read-only and available to any authenticated account
 * regardless of role: the team screen shows every member, not just socios.
 * It hides deactivated colaboradores by default (BE-10) — `includeInactive`
 * is only honored when the account belongs to an active socio (see
 * {@link MembersService.list}); it does not require a full
 * {@link SocioGuard} selection, since no device is needed to list people.
 *
 * `create`, `setCommissionRate`, `patch`, `deactivate` and `reactivate` all
 * require {@link SocioGuard}: adding people, configuring pay and
 * activating/deactivating staff are owner-only decisions.
 */
@ApiTags('members')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(
    @Inject(MembersService) private readonly members: MembersService,
    @Inject(CommissionsService)
    private readonly commissions: CommissionsService,
  ) {}

  @Get()
  @ApiExample('members')
  @UseGuards(AuthGuard)
  list(
    @Req() request: AuthenticatedRequest,
    @Query(validate(MemberListDto)) query: MemberListDto,
  ) {
    return this.members.list(
      request.account.contextId,
      query,
      request.account.memberId,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Add a socio or a colaborador with their own login',
    description:
      'Socio only. Creates the Member and its own login (bound to that ' +
      'Member, so it can only act as them) in one transaction and emails ' +
      'the username and a temporary password to `correo`, which is not ' +
      'stored. If the email cannot be sent nothing is created (502). ' +
      '`commissionRateBps` is rejected (400) for a socio. The response ' +
      '`credentialsEmail` says where the credentials went: `member` or ' +
      '`approver-fallback` (Resend test mode). The password is never ' +
      'returned.',
  })
  @UseGuards(SocioGuard)
  create(
    @Req() request: AuthenticatedRequest,
    @Body(validate(CreateMemberDto)) dto: CreateMemberDto,
  ) {
    return this.members.create(request, dto);
  }

  @Patch(':id/commission-rate')
  @ApiExample('memberRate')
  @UseGuards(SocioGuard)
  setCommissionRate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(SetMemberCommissionRateDto)) dto: SetMemberCommissionRateDto,
  ) {
    return this.commissions.setMemberRate(
      request.account.contextId,
      id,
      dto.rateBps,
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: "Edit a Member's name and/or commission rate",
    description:
      "name may be edited on any Member; commissionRateBps is rejected " +
      "(400) when the target is a socio, since a socio is never subject " +
      'to a sales commission.',
  })
  @UseGuards(SocioGuard)
  patch(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(validate(PatchMemberDto)) dto: PatchMemberDto,
  ) {
    return this.members.patch(request, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Deactivate a colaborador (soft delete)',
    description:
      'Sets active=false; rejected (400) when the target is a socio — ' +
      'socios cannot be deactivated through this mechanism. Idempotent ' +
      'for an already-inactive colaborador. All historical references ' +
      '(sales, audits, incidencias, deudas, abonos, commissions) remain ' +
      'intact.',
  })
  @UseGuards(SocioGuard)
  deactivate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.members.deactivate(request, id);
  }

  @Patch(':id/reactivate')
  @ApiOperation({
    summary: 'Reactivate a deactivated colaborador',
    description: 'Sets active=true again. Idempotent for an already-active Member.',
  })
  @UseGuards(SocioGuard)
  reactivate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.members.reactivate(request, id);
  }
}
