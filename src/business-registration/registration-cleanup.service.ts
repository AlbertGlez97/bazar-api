import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { REGISTRATION_RULES } from './registration-limits.js';

/** Filas que se borran por pasada: por lotes, para no cargar la base de datos. */
export const CLEANUP_BATCH_SIZE = 200;

/**
 * Limpieza de solicitudes de registro, sin dependencias nuevas ni tareas programadas: corre
 * UNA VEZ al arrancar el API y de nuevo con cada solicitud nueva, por lotes de 200 filas.
 * Borra:
 *   - sin confirmar el correo ("pendiente_correo") a los 7 días de creadas;
 *   - rechazadas, 30 días después de rechazarse;
 *   - vencidas ("pendiente" cuyo enlace de aprobación venció), 30 días después de vencer.
 * NUNCA borra una solicitud aprobada (de ella nació una cuenta). No registra datos personales.
 */
@Injectable()
export class RegistrationCleanupService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegistrationCleanupService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    // Sin esperar: un fallo de limpieza nunca debe impedir que el API arranque.
    void this.runBatch().catch((error: unknown) =>
      this.logger.warn(`La limpieza de solicitudes falló al arrancar: ${error instanceof Error ? error.name : 'error'}`),
    );
  }

  /** Borra hasta `batchSize` solicitudes vencidas. Devuelve cuántas borró. */
  async runBatch(now: Date = new Date(), batchSize: number = CLEANUP_BATCH_SIZE): Promise<number> {
    const unconfirmedBefore = new Date(now.getTime() - REGISTRATION_RULES.unconfirmedRetentionMs);
    const keptSince = new Date(now.getTime() - REGISTRATION_RULES.rejectedOrExpiredRetentionMs);
    const categories = [
      { status: 'pendiente_correo' as const, createdAt: { lt: unconfirmedBefore } },
      { status: 'rechazado' as const, resolvedAt: { lt: keptSince } },
      { status: 'pendiente' as const, tokenExpiresAt: { lt: keptSince } },
    ];
    let remaining = batchSize;
    let deleted = 0;
    for (const where of categories) {
      if (remaining <= 0) break;
      const rows = await this.prisma.businessRegistrationRequest.findMany({
        where,
        select: { id: true },
        take: remaining,
      });
      if (rows.length === 0) continue;
      const result = await this.prisma.businessRegistrationRequest.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      deleted += result.count;
      remaining -= result.count;
    }
    if (deleted > 0) this.logger.log(`Limpieza de solicitudes: ${deleted} borradas.`);
    return deleted;
  }
}
