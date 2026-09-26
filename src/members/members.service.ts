import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import type { MemberListDto, PatchMemberDto } from './dto/member.dto.js';
import { isRequestingSocio } from '../auth/socio-check.util.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

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
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Re-validates the actor inside the transaction rather than trusting
   * {@link SocioGuard}'s pre-transaction read (same rationale as
   * ProductsService/SalesService/DeudasService.authorize), so a device
   * deauthorized or a member demoted/deactivated between the guard
   * running and the transaction committing is still honored.
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
    return member.id;
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
    requestingMemberId?: string,
    accountMemberId?: string | null,
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
