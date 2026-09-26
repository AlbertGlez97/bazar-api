import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type {
  CreateMemberDto,
  MemberListDto,
  PatchMemberDto,
} from './dto/member.dto.js';
import { isRequestingSocio } from '../auth/socio-check.util.js';
import {
  isAccountUsernameConflict,
  isTransactionExpired,
} from '../business-registration/approve-failures.js';
import {
  deriveUniqueUsername,
  generateTemporaryPassword,
  normalizeSocioEmail,
} from '../business-registration/initial-credentials.js';
import { fullName } from '../common/full-name.js';
import { hashPassword } from '../common/password.js';
import { createServerId } from '../common/server-id.js';
import { EmailService } from '../email/email.service.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

/**
 * The create transaction sends the credentials email from INSIDE it, so its
 * timeout must stay well above the email's total deadline
 * (`CREDENTIALS_EMAIL_TIMEOUT_MS`, 10 s): the email then fails first, in a
 * controlled way (rollback and 502), instead of the transaction expiring under
 * a pending call. A unit test pins the relation, as for the business approval.
 */
export const MEMBER_CREATE_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 15_000,
};

/** How many times `create` re-derives a username lost to a racing insert. */
const USERNAME_RACE_ATTEMPTS = 3;

/** What `POST /members` answers; never the password or its hash. */
export interface CreatedMember {
  id: string;
  name: string;
  role: 'socio' | 'colaborador';
  active: boolean;
  commissionRateBps: number | null;
  createdByMemberId: string | null;
  username: string;
  /**
   * Where the credentials email went: the new person's own address, or the
   * approver as a backup because Resend test mode refused it.
   */
  credentialsEmail: 'member' | 'approver-fallback';
}

/**
 * `list` is read-only, available to any authenticated account regardless
 * of role (the shared-tablet person selector needs every eligible member
 * visible to a colaborador too — the selector's whole purpose is to let
 * someone identify themselves *before* any selection exists), and hides
 * deactivated colaboradores by default (BE-10) since a deactivated person
 * cannot act. `includeInactive` is only honored when the request also
 * identifies an active socio via the optional `x-member-id` header (see
 * {@link isRequestingSocio}); for anyone else it is silently ignored
 * rather than rejected with 403 (see `list`'s own doc for the rationale).
 *
 * `patch`, `deactivate` and `reactivate` are socio-only (enforced by
 * {@link SocioGuard} at the controller) and never touch a socio's `active`
 * flag: socios (Alberto y Adid) are owners, not removable staff, so
 * deactivating one is rejected explicitly rather than silently ignored.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  /**
   * Re-validates the actor inside the transaction rather than trusting
   * {@link SocioGuard}'s pre-transaction read (same rationale as
   * ProductsService/SalesService/DeudasService.authorize), so a device
   * deauthorized or a member demoted/deactivated between the guard
   * running and the transaction committing is still honored.
   *
   * Returns the acting socio's Member row.
   *
   * @throws ForbiddenException when there is no selection, or the
   * account, member (must be `active` and `role: 'socio'`) or device do
   * not resolve within the actor's `contextId`.
   */
  private async authorize(tx: Prisma.TransactionClient, actor: Actor) {
    if (!actor.selection) throw new ForbiddenException();
    const account = await tx.account.findFirst({
      where: {
        id: actor.account.id,
        contextId: actor.account.contextId,
        active: true,
      },
    });
    const member = await tx.member.findFirst({
      where: {
        id: actor.selection.memberId,
        contextId: actor.account.contextId,
        role: 'socio',
        active: true,
      },
    });
    const device = await tx.device.findFirst({
      where: {
        id: actor.selection.deviceId,
        contextId: actor.account.contextId,
        authorized: true,
      },
    });
    if (!account || !member || !device) throw new ForbiddenException();
    return member;
  }

  /**
   * Adds a person to the actor's business (`POST /members`): the Member and
   * its own login (an Account bound to it through `Account.memberId`, so that
   * login can only ever act as this Member) are created in ONE transaction,
   * and the credentials (username + a random temporary password) are emailed
   * to `dto.correo` as its LAST step. If the email cannot be sent nothing is
   * persisted and the answer is 502. The correo is used only for that email;
   * it is not stored.
   *
   * The username comes from {@link deriveUniqueUsername} (the normalized
   * correo when free, otherwise a random-suffix fallback). Two requests racing
   * for the same username end in a unique violation on `Account.username`,
   * which rolls the transaction back; it is retried a bounded number of times
   * (a fresh derivation each time) and then answered as 409.
   *
   * @throws BadRequestException when a commission rate is sent for a socio.
   * @throws ForbiddenException when the actor is not an active socio.
   * @throws ConflictException when the username race is lost every attempt.
   * @throws BadGatewayException when the email fails or the transaction
   * expires (everything rolled back, safe to retry).
   */
  async create(actor: Actor, dto: CreateMemberDto): Promise<CreatedMember> {
    if (dto.role === 'socio' && dto.commissionRateBps !== undefined)
      throw new BadRequestException(
        'commissionRateBps does not apply to a socio',
      );
    // `@IsEmail()` is more permissive than the recipient pattern the rest of
    // the system uses; refuse what the credentials email could not go to.
    const correo = normalizeSocioEmail(dto.correo);
    if (!correo)
      throw new BadRequestException(
        'Escribe un correo válido, por ejemplo nombre@dominio.com',
      );

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          (tx) => this.createInTransaction(tx, actor, dto, correo),
          MEMBER_CREATE_TRANSACTION_OPTIONS,
        );
      } catch (error) {
        if (isAccountUsernameConflict(error)) {
          if (attempt < USERNAME_RACE_ATTEMPTS) continue;
          this.logger.error(
            `Could not reserve a username for a new member after ${attempt} attempts`,
          );
          throw new ConflictException(
            'No se pudo asignar un usuario a la persona nueva. Inténtalo de nuevo.',
          );
        }
        if (isTransactionExpired(error)) {
          this.logger.error('Member creation transaction expired; rolled back');
          throw new BadGatewayException(
            'No se pudo agregar a la persona a tiempo. No se creó nada: inténtalo de nuevo.',
          );
        }
        throw error;
      }
    }
  }

  private async createInTransaction(
    tx: Prisma.TransactionClient,
    actor: Actor,
    dto: CreateMemberDto,
    correo: string,
  ): Promise<CreatedMember> {
    const socio = await this.authorize(tx, actor);
    const contextId = actor.account.contextId;
    const name = fullName(dto.nombre, dto.apellidos);

    const username = await deriveUniqueUsername(
      { correo, nombreNegocio: name },
      async (candidate) =>
        (await tx.account.findUnique({
          where: { username: candidate },
          select: { id: true },
        })) !== null,
    );
    const temporaryPassword = generateTemporaryPassword();

    const member = await tx.member.create({
      data: {
        id: createServerId(),
        name,
        role: dto.role,
        contextId,
        active: true,
        commissionRateBps: dto.commissionRateBps ?? null,
        createdByMemberId: socio.id,
      },
    });
    // Same context as the Member; `memberId` binds this login to it.
    await tx.account.create({
      data: {
        id: createServerId(),
        username,
        passwordHash: await hashPassword(temporaryPassword),
        contextId,
        memberId: member.id,
        active: true,
      },
    });

    let delivery: Awaited<
      ReturnType<EmailService['sendMemberCredentialsEmail']>
    >;
    try {
      delivery = await this.email.sendMemberCredentialsEmail({
        to: correo,
        memberName: name,
        username,
        temporaryPassword,
        role: dto.role,
        addedByName: socio.name,
      });
    } catch (cause) {
      // Resend's error text never carries the password (pinned by the email
      // service tests); only the reason is logged, never the credentials.
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.logger.error(
        `Credentials email for a new member failed; creation rolled back: ${reason}`,
      );
      throw new BadGatewayException(
        'No se pudo enviar el correo con las credenciales. No se creó a la persona: inténtalo de nuevo.',
      );
    }

    return {
      id: member.id,
      name: member.name,
      role: member.role,
      active: member.active,
      commissionRateBps: member.commissionRateBps,
      createdByMemberId: member.createdByMemberId,
      username,
      credentialsEmail: delivery.deliveredTo,
    };
  }

  /**
   * Deactivated colaboradores are excluded by default (BE-10).
   * `includeInactive: true` is only honored when `requestingMemberId`
   * (from the caller's optional `x-member-id` header) resolves to an
   * active socio in this context — this endpoint is used *before* any
   * Member has necessarily been selected (populating the person selector
   * itself), so it cannot require a full {@link ContextGuard}/
   * {@link SocioGuard} selection to already exist just to make this one
   * parameter safe. For anyone else, the parameter is silently ignored
   * (not rejected with 403): the far more likely cause is a stale or
   * accidental query parameter from the frontend than a deliberate
   * attempt to browse deactivated staff, and the roster this exposes
   * (id/name/role/active) carries low risk even in that unlikely case.
   */
  async list(
    contextId: string,
    query: MemberListDto,
    requestingMemberId: string | undefined,
    accountMemberId: string | null,
  ) {
    const includeInactive =
      query.includeInactive &&
      (await isRequestingSocio(
        this.prisma,
        contextId,
        requestingMemberId,
        accountMemberId,
      ));
    return this.prisma.member.findMany({
      where: {
        contextId,
        ...(includeInactive ? {} : { active: true }),
      },
      select: { id: true, name: true, role: true, active: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Edits a colaborador's `name` and/or `commissionRateBps` in one call.
   * `name` may be edited on any Member (socio or colaborador) — renaming
   * yourself is not commission-related and carries no special risk — but
   * `commissionRateBps` is rejected outright when the target is a socio,
   * since a socio is never subject to a sales commission and the field is
   * meaningless for them.
   *
   * @throws NotFoundException when the target does not exist in this
   * context.
   * @throws BadRequestException when the DTO has no fields set, or
   * `commissionRateBps` is set for a `socio` target.
   */
  async patch(actor: Actor, id: string, dto: PatchMemberDto) {
    if (dto.name === undefined && dto.commissionRateBps === undefined)
      throw new BadRequestException('At least one editable field is required');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${id}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const target = await tx.member.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (!target) throw new NotFoundException();
      if (dto.commissionRateBps !== undefined && target.role === 'socio')
        throw new BadRequestException(
          'commissionRateBps does not apply to a socio',
        );
      const updated = await tx.member.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.commissionRateBps !== undefined
            ? { commissionRateBps: dto.commissionRateBps }
            : {}),
        },
      });
      return updated;
    });
  }

  /**
   * Soft-deletes (`active: false`) a colaborador. Every historical
   * reference (Sale.memberId, ProductAudit.memberId,
   * Incidencia.resolvedByMemberId, Deuda.createdByMemberId,
   * Abono.receivedByMemberId, and their past Commission calculations)
   * stays intact and queryable — deactivation only removes the person
   * from the seller selector and the default roster listing, and blocks
   * them from being selected again ({@link ContextGuard}).
   *
   * A socio can never be deactivated through this endpoint: socios are
   * owners of the bazar, not removable staff, and there is no equivalent
   * "reassign ownership" flow in this system — rejecting explicitly
   * (400) avoids a socio being locked out by mistake or malice with no
   * recovery path other than direct database access.
   *
   * Idempotent, matching ProductsService.deactivate: deactivating an
   * already-inactive colaborador is a no-op returning current state, not
   * an error.
   *
   * @throws NotFoundException when the target does not exist in this
   * context.
   * @throws BadRequestException when the target's role is `socio`.
   */
  async deactivate(actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${id}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const target = await tx.member.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (!target) throw new NotFoundException();
      if (target.role === 'socio')
        throw new BadRequestException('No se puede desactivar a un socio');
      if (!target.active) return target;
      return tx.member.update({ where: { id }, data: { active: false } });
    });
  }

  /**
   * Reverses {@link deactivate}. Available for both roles in principle,
   * but only ever meaningful for a colaborador in practice since a socio
   * is never deactivated in the first place.
   *
   * @throws NotFoundException when the target does not exist in this
   * context.
   */
  async reactivate(actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${id}::uuid AND "contextId" = ${actor.account.contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const target = await tx.member.findFirst({
        where: { id, contextId: actor.account.contextId },
      });
      if (!target) throw new NotFoundException();
      if (target.active) return target;
      return tx.member.update({ where: { id }, data: { active: true } });
    });
  }
}
