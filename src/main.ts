import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureStaticStorage } from './storage/static-storage.js';
import { configureApiDocs } from './docs/swagger.js';
import { configureCors } from './http/cors.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // All controllers live under /api/v1. The explicit /docs* and
  // /uploads/products mounts intentionally stay at the origin. This must
  // run before the static/docs configuration so OpenAPI paths carry the
  // prefix.
  app.setGlobalPrefix('api/v1');
  // No-op unless ALLOWED_ORIGIN is set; see configureCors. Needed only when
  // a browser frontend is served from a different origin than the API.
  configureCors(app);
  configureStaticStorage(app);
  // No-op unless ENABLE_API_DOCS=true; see configureApiDocs for the
  // 404-vs-401 and credential-isolation rationale.
  configureApiDocs(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
