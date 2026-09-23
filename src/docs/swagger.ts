import basicAuth from 'express-basic-auth';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Registers Swagger UI (OpenAPI generated from the existing controllers and
 * DTOs) at `/docs`, but only when explicitly opted into.
 *
 * Two independent gates apply, in this order:
 *
 * 1. `ENABLE_API_DOCS` must be exactly `'true'`. If it is absent or any
 *    other value, this function returns immediately without registering
 *    any middleware, route or document — `/docs` then falls through to
 *    Nest's normal 404, the same as any other unknown path. This is
 *    deliberate: an unauthenticated 401 would still confirm to a scanner
 *    that "something interesting" lives at `/docs`; a plain 404 does not.
 *    Production deployments are expected to leave this unset.
 * 2. When enabled, `/docs` is additionally gated by its own HTTP Basic
 *    Auth layer (`DOCS_USER`/`DOCS_PASSWORD`), applied as Express
 *    middleware *before* `SwaggerModule.setup` registers the route. This
 *    credential pair is intentionally separate from the JWT-based guards
 *    (AuthGuard/ContextGuard) used by the business API: documentation
 *    access and business-data access are different trust boundaries with
 *    different audiences (developers/ops vs. socios and colaboradores),
 *    and reusing one system for both would tie their blast radii together.
 *
 * @throws Error at startup if `ENABLE_API_DOCS=true` but either
 * credential env var is missing, so a misconfigured deployment fails
 * loudly instead of silently serving the docs unprotected or refusing to
 * authenticate anyone.
 */
export function configureApiDocs(app: NestExpressApplication): void {
  if (process.env.ENABLE_API_DOCS !== 'true') return;

  const user = process.env.DOCS_USER;
  const password = process.env.DOCS_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'ENABLE_API_DOCS=true requires DOCS_USER and DOCS_PASSWORD to also be set',
    );
  }

  app.use(
    '/docs',
    basicAuth({
      users: { [user]: password },
      challenge: true,
      realm: 'bazar-api-docs',
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Bazar API')
    .setDescription(
      'Internal point-of-sale backend for the bazar (auth, members, devices, products, sales)',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);
}
