# Swagger PS5 bazaar examples

Document all 24 current controller operations with consistent request/response examples, authentication/context headers, path/query parameters, multipart upload and errors. Metadata only; preserve runtime behavior and the parent's running watch server.

## Scope and constraints
- Stay on feat/backend-e0-be09-deudas; no commit or push until parent review.
- Use fictional UUIDs/credentials, Alberto and Adid as socios, Carlos and Javier as colaboradores, and PS5 videogames. Amounts are integer MXN cents.
- Read actual controllers, DTOs, Prisma models and service response mapping; do not invent envelopes, fields or endpoints.
- TDD: not applicable to documentation metadata; user explicitly requested build/document readback rather than new tests. Existing BE05+ policy remains unchanged.
- Runners: npm.cmd run build; focused SwaggerModule.createDocument readback without listening or touching database/server.
- Forecast: 500–800 authored lines across shared metadata/examples and controller decorations; 400-line heuristic advisory, delivery ask-on-risk. Commit pending parent review.

## Tasks
- [ ] DOCS-1: Add coherent examples and operation metadata for every exposed controller route.
- [ ] DOCS-2: Build, generate OpenAPI, assert route coverage/examples and preserve running server; record evidence.

## Progress
Inspected all controllers, DTOs and response mappers. Current branch clean. Shared composed decorators will reduce repeated auth/error/pagination metadata while keeping route contracts explicit.

## Next step
Implement metadata-only changes, normalize touched files, build and read back generated OpenAPI.
