import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { tenantIsolationExtension } from './tenant.extension.js';

/**
 * `PrismaService` is provided via a factory rather than directly as a
 * class provider (BE-11): the actual injectable instance every
 * `@Inject(PrismaService)` in this codebase receives is the *tenant-
 * isolation-extended* client (see tenant.extension.ts), not the bare
 * `PrismaService` instance. `$extends()` returns a new client object
 * rather than mutating the one it is called on, so this indirection is
 * the only way to keep every existing `@Inject(PrismaService) private
 * readonly prisma: PrismaService` call site in the whole app unchanged —
 * they still see the exact same shape (`this.prisma.product.findMany`,
 * `this.prisma.$transaction`, ...), just automatically tenant-scoped now.
 *
 * `$extends()`'s result does not carry over `PrismaService`'s own
 * `onModuleInit`/`onModuleDestroy` methods (those are Nest-specific, not
 * part of the Prisma Client shape it preserves), so they are re-attached
 * by hand here, delegating to the original (unextended) instance's
 * `$connect`/`$disconnect` — those two *are* real PrismaClient methods
 * and work identically on either the base or the extended client, since
 * they operate on the shared underlying connection.
 */
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => {
        const base = new PrismaService();
        const extended = tenantIsolationExtension(base);
        Object.assign(extended, {
          onModuleInit: () => base.onModuleInit(),
          onModuleDestroy: () => base.onModuleDestroy(),
        });
        return extended as unknown as PrismaService;
      },
    },
  ],
  exports: [PrismaService],
})
export class DatabaseModule {}
