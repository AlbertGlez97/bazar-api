import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import {
  generateDeviceToken,
  hashDeviceToken,
} from '../common/device-secret.js';
import { createServerId } from '../common/server-id.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import type { Device, Prisma } from '../generated/prisma/client.js';
import type {
  CreateDeviceDto,
  IdentifyDeviceDto,
  ReissueDeviceDto,
} from './dto/device.dto.js';

type Actor = Pick<AuthenticatedRequest, 'account' | 'selection'>;

/**
 * The activation email is sent from INSIDE the write transaction (so a failed
 * send rolls the change back). `timeout` must stay well above
 * `CREDENTIALS_EMAIL_TIMEOUT_MS`, the total deadline of that email including
 * its backup forward (at least a 5 s margin for the queries), so the email
 * fails first, in a controlled way, instead of the transaction expiring under
 * a pending call. A unit test pins the relation.
 */
export const DEVICE_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 15_000 };

/** Plain wrong credentials (unknown identifier or name): the original 403. */
export const UNKNOWN_DEVICE_MESSAGE = 'Device is unknown or unauthorized';

/** The one-time identifier was already used to activate the device. */
export const ACTIVATION_CODE_USED_MESSAGE =
  'Este identificador ya fue usado. Pide a un socio que te genere uno nuevo.';

/** The device was revoked: its code cannot activate anything any more. */
export const DEVICE_REVOKED_MESSAGE =
  'Este dispositivo fue revocado. Pide a un socio que te genere un identificador nuevo.';

/** What a caller sees when the activation email could not be delivered. */
export const ACTIVATION_EMAIL_FAILED_MESSAGE =
  'No se pudo enviar el correo con el código de activación, así que no se hizo ningún cambio. Intenta de nuevo, o hazlo sin correo y comparte el código tú mismo.';

type DeviceRow = Pick<
  Device,
  | 'id'
  | 'name'
  | 'identifier'
  | 'status'
  | 'tokenHash'
  | 'createdAt'
  | 'activatedAt'
  | 'revokedAt'
>;

const DEVICE_SELECT = {
  id: true,
  name: true,
  identifier: true,
  status: true,
  tokenHash: true,
  createdAt: true,
  activatedAt: true,
  revokedAt: true,
} as const;

/**
 * What the API shows of a device. Never the token hash, and the identifier
 * ONLY while it is still an unconsumed activation code (`pendiente_activacion`)
 * and the caller asked for it: once used, or after a revoke, it is not shown
 * again. `legacy` marks a device that authenticates with `x-device-id` alone
 * (active, no token hash): every device that existed before BE-12, and the
 * candidate to `reissue` into the token model.
 */
function summarize(device: DeviceRow, options: { withIdentifier: boolean }) {
  const summary = {
    id: device.id,
    name: device.name,
    status: device.status,
    legacy: device.status === 'activo' && device.tokenHash === null,
    createdAt: device.createdAt,
    activatedAt: device.activatedAt,
    revokedAt: device.revokedAt,
  };
  return options.withIdentifier && device.status === 'pendiente_activacion'
    ? { ...summary, identifier: device.identifier }
    : summary;
}

/**
 * Device management with one-time activation (BE-12).
 *
 * Lifecycle: a socio creates a device (`pendiente_activacion`, a fresh
 * one-time `identifier`, `authorized = false`); the person activates it ONCE
 * with the identifier and the exact name (`identify`), which makes it `activo`
 * (`authorized = true`) and hands out a `deviceToken` whose hash is the only
 * thing stored; a socio can `revoke` it (`revocado`, `authorized = false`) or
 * `reissue` it (back to `pendiente_activacion` with a new identifier and no
 * token). `authorized` stays the operating gate read by ContextGuard and by
 * the services that re-validate the device; this service keeps it in step with
 * `status`: (pendiente_activacion, false), (activo, true) or (revocado, false).
 *
 * The management methods are socio-only (enforced by SocioGuard at the
 * controller, re-validated inside the transaction like MembersService). They
 * never null the token hash on revoke: a device with no hash is LEGACY and
 * would authenticate with `x-device-id` alone.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EmailService) private readonly email: EmailService,
  ) {}

  /**
   * Re-validates the actor inside the transaction rather than trusting
   * SocioGuard's pre-transaction read (same rationale as MembersService), so
   * a socio demoted/deactivated or a device deauthorized between the guard and
   * the commit is still honored.
   */
  private async authorize(tx: Prisma.TransactionClient, actor: Actor) {
    if (!actor.selection) throw new ForbiddenException();
    const { contextId } = actor.account;
    const account = await tx.account.findFirst({
      where: { id: actor.account.id, contextId, active: true },
    });
    const member = await tx.member.findFirst({
      where: {
        id: actor.selection.memberId,
        contextId,
        role: 'socio',
        active: true,
      },
    });
    const device = await tx.device.findFirst({
      where: { id: actor.selection.deviceId, contextId, authorized: true },
    });
    if (!account || !member || !device) throw new ForbiddenException();
  }

  /**
   * Emails the activation code when a `correoEnvio` was given (as the LAST
   * step of the transaction: a delivery failure throws and rolls the whole
   * change back), and returns the device WITHOUT its identifier plus where the
   * email went. Without `correoEnvio` it returns the device WITH its
   * identifier so the socio can copy it.
   */
  private async deliverOrReveal(device: Device, correoEnvio: string | undefined) {
    if (!correoEnvio) return summarize(device, { withIdentifier: true });
    try {
      const result = await this.email.sendDeviceActivationEmail({
        to: correoEnvio,
        deviceName: device.name,
        identifier: device.identifier,
      });
      return {
        ...summarize(device, { withIdentifier: false }),
        deliveredTo: result.deliveredTo,
      };
    } catch (error) {
      const reason =
        error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
      this.logger.error(`Device activation email failed (${reason})`);
      throw new BadGatewayException(ACTIVATION_EMAIL_FAILED_MESSAGE);
    }
  }

  /** Lists the business devices; the identifier only for unconsumed codes. */
  async list(contextId: string) {
    const devices = await this.prisma.device.findMany({
      where: { contextId },
      select: DEVICE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return devices.map((device) => summarize(device, { withIdentifier: true }));
  }

  /**
   * Creates a pending device with a one-time identifier the server generates.
   *
   * @throws BadGatewayException when `correoEnvio` was given and the email
   * could not be delivered: the device is not created.
   */
  async create(actor: Actor, dto: CreateDeviceDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.authorize(tx, actor);
      const device = await tx.device.create({
        data: {
          id: createServerId(),
          name: dto.name,
          identifier: createServerId(),
          contextId: actor.account.contextId,
          status: 'pendiente_activacion',
          authorized: false,
          tokenHash: null,
        },
      });
      return this.deliverOrReveal(device, dto.correoEnvio);
    }, DEVICE_TRANSACTION_OPTIONS);
  }

  /**
   * Activates a pending device with its one-time identifier and exact name.
   *
   * - Pending: activates it atomically (only one of several concurrent calls
   *   wins) and returns `{ deviceId, deviceToken }`. The token is shown ONLY
   *   here; only its hash is stored.
   * - Already activated through this flow, or revoked: 409 with a message
   *   that says so, different from the 403 for wrong credentials.
   * - LEGACY (active, no token hash: it existed before BE-12): exactly the
   *   previous behavior, `{ deviceId }` with no token, as long as it is
   *   authorized.
   *
   * @throws ForbiddenException when no device of this business matches the
   * identifier and name, or a legacy device is not authorized.
   * @throws ConflictException when the identifier was already used or the
   * device was revoked.
   */
  async identify(actor: Pick<AuthenticatedRequest, 'account'>, dto: IdentifyDeviceDto) {
    const { contextId } = actor.account;
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findFirst({
        where: { contextId, identifier: dto.identifier, name: dto.name },
      });
      if (!device) throw new ForbiddenException(UNKNOWN_DEVICE_MESSAGE);
      if (device.status === 'revocado')
        throw new ConflictException(DEVICE_REVOKED_MESSAGE);
      if (device.status === 'activo') {
        if (device.tokenHash !== null)
          throw new ConflictException(ACTIVATION_CODE_USED_MESSAGE);
        if (!device.authorized)
          throw new ForbiddenException(UNKNOWN_DEVICE_MESSAGE);
        return { deviceId: device.id };
      }
      // Pending. The conditional update is the race guard: under READ
      // COMMITTED a concurrent activation blocks on the row, then re-checks
      // the status and matches nothing, so exactly one caller wins.
      const deviceToken = generateDeviceToken();
      const claimed = await tx.device.updateMany({
        where: { id: device.id, contextId, status: 'pendiente_activacion' },
        data: {
          status: 'activo',
          authorized: true,
          activatedAt: new Date(),
          tokenHash: hashDeviceToken(deviceToken),
        },
      });
      if (claimed.count === 0)
        throw new ConflictException(ACTIVATION_CODE_USED_MESSAGE);
      return { deviceId: device.id, deviceToken };
    });
  }

  /**
   * Revokes a device: `revocado`, `authorized = false`, `revokedAt` set. Its
   * token stops working on the very next request (ContextGuard rejects any
   * unauthorized device). The token hash is KEPT on purpose. Idempotent.
   *
   * @throws NotFoundException when the device is not of this business.
   */
  async revoke(actor: Actor, id: string) {
    const { contextId } = actor.account;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Device" WHERE id = ${id}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const target = await tx.device.findFirst({ where: { id, contextId } });
      if (!target) throw new NotFoundException();
      if (target.status === 'revocado')
        return summarize(target, { withIdentifier: false });
      const updated = await tx.device.update({
        where: { id },
        data: { status: 'revocado', authorized: false, revokedAt: new Date() },
      });
      return summarize(updated, { withIdentifier: false });
    }, DEVICE_TRANSACTION_OPTIONS);
  }

  /**
   * Turns a device back into a pending one with a NEW one-time identifier: no
   * token, `authorized = false`, timestamps cleared. The old token and the old
   * identifier stop working immediately. Works on active, legacy and revoked
   * devices (this is how a legacy device moves to the token model).
   *
   * @throws NotFoundException when the device is not of this business.
   * @throws BadGatewayException when `correoEnvio` was given and the email
   * could not be delivered: nothing changes and the old credentials keep
   * working.
   */
  async reissue(actor: Actor, id: string, dto: ReissueDeviceDto) {
    const { contextId } = actor.account;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Device" WHERE id = ${id}::uuid AND "contextId" = ${contextId} FOR UPDATE`;
      await this.authorize(tx, actor);
      const target = await tx.device.findFirst({ where: { id, contextId } });
      if (!target) throw new NotFoundException();
      const updated = await tx.device.update({
        where: { id },
        data: {
          identifier: createServerId(),
          status: 'pendiente_activacion',
          authorized: false,
          tokenHash: null,
          activatedAt: null,
          revokedAt: null,
        },
      });
      return this.deliverOrReveal(updated, dto.correoEnvio);
    }, DEVICE_TRANSACTION_OPTIONS);
  }
}
