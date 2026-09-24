import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runInFreshTenantScope } from './tenant-context.js';

/**
 * Establishes an empty per-request tenant scope (see tenant-context.ts)
 * *before* any guard runs, by wrapping the rest of the request's
 * processing — guards, interceptors, the controller, and every service/
 * Prisma call made along the way — inside `AsyncLocalStorage.run(...)`.
 *
 * This has to be a middleware, not something done from within a guard:
 * `CanActivate` only returns a boolean/Promise<boolean> before Nest moves
 * on to the next guard/handler, it does not get a callback it can wrap
 * the rest of the request in. A guard (AuthGuard, specifically — see its
 * own doc comment) can still *populate* `contextId` into the store this
 * middleware already opened, because `AsyncLocalStorage` context persists
 * across the whole async chain the middleware's `next()` call kicks off,
 * not just its own synchronous return.
 *
 * Applied to every route (`consumer.apply(...).forRoutes('*')` in
 * AppModule), including fully public ones (login, business-registration):
 * those never populate a `contextId`, so any tenant-scoped model they
 * might accidentally touch still fails closed via
 * `resolveTenantAccess` — a store existing with no `contextId` is
 * different from no store at all (see tenant-context.ts).
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction) {
    runInFreshTenantScope(() => next());
  }
}
