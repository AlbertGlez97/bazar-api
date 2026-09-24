# Contrato de la API de Bazar para el frontend

Referencia de todos los endpoints del backend `bazar-api`, pensada para quien construye `bazar-frontend` (Vue 3 + Axios). Cada dato de este documento se derivó del código (controladores, DTOs, guards, servicios) y de los tests e2e, no de Swagger ni de memoria. **El repositorio del backend es la fuente de verdad**: si este archivo y el código difieren, gana el código; avisa para corregir el documento.

- Fecha del documento: 2026-09-24.
- Base de código: rama `feat/backend-e0-be11-multitenancy`, commit `1b1e449` ("fix(api): address the two advisory findings of the prefix review"), árbol de trabajo limpio.
- Alcance: 33 rutas de negocio bajo `/api/v1` (índice completo en el [Apéndice A](#apendice-a-indice-de-rutas)) más los montajes fuera del prefijo (`/docs*`, `/uploads/products/...`).
- Los ejemplos usan valores ficticios (`eyJ...` para tokens, `socio@example.test` como usuario). Los identificadores `bf030001-...` son los socios sembrados por `prisma/seed-data.ts`; el resto de UUID de los ejemplos son ficticios (mismos valores que `src/docs/bazaar-examples.ts`). Cuando un ejemplo no proviene de un test, se indica "ejemplo construido a partir del DTO".
- Cada endpoint termina con una línea **Fuente:** con referencias `archivo:línea` para auditar la afirmación.
- **Verificación en vivo (2026-09-24):** además de contrastar con el código, el comportamiento se ejecutó contra un servidor real (`npm run start:dev`, base de desarrollo, en un contexto temporal con cuenta, socio, colaborador y dispositivo propios, borrado después): autenticación y guards, paginación y sus límites, altas, ediciones y borrados lógicos, subida de imágenes, ventas (incluida una carrera real de stock que devolvió `201` con `rechazada_por_conflicto`), incidencias, comisiones, reportes, deudas y las páginas de business-registration. El resultado está en el [Apéndice B](#apendice-b-aclaraciones). No se envió un `POST /business-registration` válido para no disparar un correo real.

## Índice

1. [Fundamentos para el frontend](#fundamentos)
   1. [URL base y prefijo](#f-base)
   2. [Montajes fuera del prefijo y `GET /api/v1`](#f-montajes)
   3. [Flujo de autenticación y guards](#f-auth)
   4. [Dinero y porcentajes](#f-dinero)
   5. [Paginación](#f-paginacion)
   6. [El caso crítico de la venta](#f-venta)
   7. [`contextId` y validación estricta](#f-context)
   8. [Forma de los errores](#f-errores)
   9. [IDs, fechas, zona horaria y enums](#f-ids)
   10. [CORS](#f-cors)
   11. [Respuestas con registros crudos](#f-crudos)
2. [Auth](#mod-auth)
3. [Members](#mod-members)
4. [Devices](#mod-devices)
5. [Products](#mod-products)
6. [Sales](#mod-sales)
7. [Incidencias](#mod-incidencias)
8. [Commissions (incluye `PATCH /settings/commission-rate`)](#mod-commissions)
9. [Reports](#mod-reports)
10. [Deudas](#mod-deudas)
11. [Business Registration](#mod-business-registration)
12. [Apéndice A: índice de rutas](#apendice-a-indice-de-rutas)
13. [Apéndice B: Aclaraciones y puntos por verificar en vivo](#apendice-b-aclaraciones)

---

<a id="fundamentos"></a>
## 1. Fundamentos para el frontend

<a id="f-base"></a>
### 1.1 URL base y prefijo global

- El servidor escucha en `process.env.PORT ?? 3000` (en desarrollo, `http://localhost:3000`).
- **Todos los controladores cuelgan de `/api/v1`** (`app.setGlobalPrefix('api/v1')`). No se conservan rutas sin prefijo: `POST /auth/login` responde 404, `POST /api/v1/auth/login` es la ruta válida (lo verifica `test/business-registration.e2e-spec.ts`, caso "prefixes production routes").
- En este documento toda ruta aparece con el prefijo completo, p. ej. `POST /api/v1/auth/login`.
- Con Axios: `baseURL = '/api/v1'` (relativo, ver [CORS](#f-cors)) y llamar `api.post('/auth/login', ...)`.

Fuente: `src/main.ts:13`, `test/business-registration.e2e-spec.ts:181-209`.

<a id="f-montajes"></a>
### 1.2 Montajes fuera del prefijo y `GET /api/v1`

Estos montajes viven en la raíz del origen, **no** bajo `/api/v1`, y no son endpoints de negocio:

| Ruta | Qué es | Acceso |
|---|---|---|
| `GET /docs`, `GET /docs-json`, `GET /docs-yaml` | Swagger UI / OpenAPI JSON / YAML | Solo existen si `ENABLE_API_DOCS=true` (si no, 404 como cualquier ruta desconocida). Cuando existen exigen **HTTP Basic Auth** con `DOCS_USER`/`DOCS_PASSWORD` (credenciales independientes de la API de negocio). No son para el frontend. `GET /api/v1/docs-json` responde 404. |
| `GET /uploads/products/<uuid>.png` | Imágenes de producto ya subidas | **Pública, sin JWT ni headers**. Responde con `X-Content-Type-Options: nosniff` y `Content-Security-Policy: default-src 'none'; sandbox`. `GET /api/v1/uploads/products/...` responde 404. |

El campo `image` de un producto es la ruta **relativa a la raíz del origen**, p. ej. `/uploads/products/6f1c2d8e-....png`, sin `/api/v1` y sin origen. Para un `<img src>` sirve tal cual si la API y el frontend comparten origen; si el frontend usa otro origen hay que anteponer el origen de la API. En desarrollo `bazar-frontend/vite.config.ts` solo hace proxy de `/api`, así que `/uploads` **no** llega al backend: hay que añadir un proxy para `/uploads` (ver [CORS](#f-cors)).

#### `GET /api/v1` (Hello World)

- Audiencia: pública, sin headers.
- Respuesta 200, `Content-Type: text/html`, cuerpo de texto plano: `Hello World!`.
- **No es un endpoint de salud/readiness**: no toca la base de datos. No lo uses para saber si el backend está listo.
- `GET /` (sin prefijo) responde 404.

Ejemplo:

```http
GET /api/v1 HTTP/1.1
```
```text
Hello World!
```

Fuente: `src/app.controller.ts:9-13`, `src/app.service.ts:5-7`, `src/docs/swagger.ts:32-62`, `src/storage/static-storage.ts:4-23`, `test/business-registration.e2e-spec.ts:181-209`.

<a id="f-auth"></a>
### 1.3 Flujo de autenticación y guards

**Iniciar sesión NO basta para operar.** La tablet es compartida entre socios y colaboradores: la cuenta (login) identifica al negocio, pero quién atiende y desde qué dispositivo se declara aparte, en cada petición. Flujo completo:

1. `POST /api/v1/auth/login` con `{ username, password }` -> `{ accessToken, tokenType, expiresIn }`. Guardar el token.
2. `GET /api/v1/members` (con `Authorization`) -> lista de personas; la persona que atiende se elige en un selector (sin PIN). Guardar el `id` elegido.
3. `POST /api/v1/devices/identify` con `{ identifier, name }` (ambos deben coincidir exactamente con un dispositivo ya autorizado, sembrado fuera de banda) -> `{ deviceId }`. Guardar el `deviceId`.
4. En **cada** petición protegida enviar:
   - `Authorization: Bearer <accessToken>`
   - `x-member-id: <id del member elegido>`
   - `x-device-id: <deviceId>`

Ejemplo de un paso 4 (construido a partir de los guards):

```http
POST /api/v1/sales HTTP/1.1
Authorization: Bearer eyJ...
x-member-id: 10000000-0000-4000-8000-000000000003
x-device-id: 20000000-0000-4000-8000-000000000001
Content-Type: application/json
```

> Nota sobre el frontend actual (2026-09-24): el interceptor de `bazar-frontend/src/services/api.ts` solo añade `Authorization`. Para los endpoints con `ContextGuard`/`SocioGuard` hay que añadir también `x-member-id` y `x-device-id`. Además ese archivo trata cualquier 401 fuera de `/auth/login` como "token expirado" (correcto para este backend, ver más abajo) y menciona `/auth/register`, que **no existe** en el backend.

#### Qué hace cada guard (`src/auth/`)

| Guard | Qué comprueba | Cuándo rechaza | HTTP | `message` |
|---|---|---|---|---|
| `AuthGuard` | Header `Authorization: Bearer <jwt>` (el esquema `Bearer` no distingue mayúsculas); el JWT (HS256, `iss=bazar-api`, `aud=bazar-client`, sin expirar) y que `sub` sea un UUID; que la cuenta exista **y esté activa** (se relee de la base en cada petición). Fija además el `contextId` del negocio para la petición. | Header ausente o mal formado, token inválido/expirado/firmado por otro emisor o audiencia, `sub` no UUID, cuenta inexistente o desactivada. Todos los casos son indistinguibles. | **401** | `"Unauthorized"` (sin campo `error`) |
| `ContextGuard` | Ejecuta primero `AuthGuard`. Luego exige `x-member-id` y `x-device-id` (cada uno un solo valor, UUID) y que el **Member** exista en el mismo `contextId` de la cuenta **y esté `active`**, y que el **Device** exista en ese `contextId` **y esté `authorized`**. | Headers ausentes, repetidos o que no sean UUID. | **403** | `"Valid member and device selection required"` |
| | | Member/Device inexistente, de otro negocio, Member desactivado o Device no autorizado. | **403** | `"Selection is not authorized for this context"` |
| `SocioGuard` | Ejecuta `ContextGuard` (y por tanto `AuthGuard`). Luego exige que el Member elegido tenga `role: "socio"` y esté activo. | El Member elegido es `colaborador`. | **403** | `"Only socios may access this resource"` |

Orden de rechazo: primero 401 (`AuthGuard`), luego 403 (selección), luego 403 (rol). Los servicios de escritura vuelven a validar la selección dentro de la transacción; si el dispositivo se revoca o el Member se desactiva justo entre el guard y el commit, la respuesta es 403 con `message: "Forbidden"`.

#### Qué guard usa cada endpoint

| Nivel | Endpoints |
|---|---|
| Ninguno (públicos) | `GET /api/v1`, `POST /api/v1/auth/login`, `POST /api/v1/business-registration`, `GET /api/v1/business-registration/approve`, `GET /api/v1/business-registration/reject` |
| Solo `AuthGuard` (basta el token; los headers `x-member-id`/`x-device-id` **no** se exigen) | `GET /api/v1/members`, `POST /api/v1/devices/identify`, `GET /api/v1/products`, `GET /api/v1/products/:id`, `GET /api/v1/products/:id/audit`, `GET /api/v1/sales/:id` |
| `ContextGuard` (token + member + device; cualquier Member activo, socio o colaborador) | `POST /api/v1/sales`, `POST /api/v1/deudas/:id/abonos` |
| `SocioGuard` (token + member socio + device) | `POST /api/v1/products`, `PATCH /api/v1/products/:id`, `POST /api/v1/products/:id/image`, `DELETE /api/v1/products/:id`, `PATCH /api/v1/products/:id/reactivate`, `PATCH /api/v1/members/:id`, `DELETE /api/v1/members/:id`, `PATCH /api/v1/members/:id/reactivate`, `PATCH /api/v1/members/:id/commission-rate`, `GET /api/v1/sales`, `GET /api/v1/incidencias`, `GET /api/v1/incidencias/:id`, `PATCH /api/v1/incidencias/:id/resolver`, `GET /api/v1/commissions`, `PATCH /api/v1/settings/commission-rate`, `GET /api/v1/reports/sales-by-period`, `GET /api/v1/reports/sales-by-member`, `POST /api/v1/deudas`, `GET /api/v1/deudas`, `GET /api/v1/deudas/:id` |

Matiz sobre los endpoints "solo `AuthGuard`": únicamente `GET /members` y `GET /products` leen `x-member-id` de forma **opcional** (para decidir si se respeta `includeInactive`, ver sus secciones); ninguno de los endpoints de este grupo exige ni lee `x-device-id`.

#### El token

Respuesta de login: `{ "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 43200 }`.

- `expiresIn` está en **segundos**: 43200 = 12 horas (`12 * 60 * 60`). Es la vida real del JWT (`exp - iat = 43200`, lo verifica `test/auth.e2e-spec.ts:150-163`).
- **No hay refresh token ni endpoint de logout.** Al expirar (o si la cuenta se desactiva o cambia de negocio) cualquier endpoint protegido responde 401 y hay que volver a hacer login. Cerrar sesión = descartar el token en el cliente.
- El token solo lleva la cuenta (`sub`); **no** lleva member ni device. La desactivación de una cuenta o de un dispositivo surte efecto de inmediato aunque el token siga vigente.
- Diseño offline: el token de 12 h cubre una jornada completa; un dispositivo que hizo login por la mañana puede seguir encolando ventas.

Fuente: `src/auth/auth.guard.ts:52-77`, `src/auth/context.guard.ts:47-77`, `src/auth/socio.guard.ts:32-46`, `src/auth/jwt.constants.ts:7`, `src/auth/auth.module.ts:20-45`, `src/auth/auth.service.ts:40-58`, `test/auth.e2e-spec.ts:150-333`.

<a id="f-dinero"></a>
### 1.4 Dinero y porcentajes

- **Dinero**: enteros en **centavos de MXN**. Todo campo de dinero termina en `Minor` (`unitPriceMinor`, `totalMinor`, `cashReceivedMinor`, `changeMinor`, `subtotalMinor`, `montoMinor`, `purchaseCostMinor`, `totalSoldMinor`, `commissionMinor`, ...). `125000` = `$1,250.00 MXN`; `12550` = `$125.50`. Para mostrar: `(minor / 100).toFixed(2)`.
- Un decimal como `125.5` en un campo de dinero es **400** (`@IsInt`): nunca envíes flotantes.
- Rango de los campos de dinero de entrada: entero `0..2147483647` (`MAX_MINOR_UNITS`), salvo `montoMinor` de abono (`1..2147483647`). El precio unitario se valida `>= 0` (un producto de precio 0 es válido).
- **Moneda**: solo `MXN`. `POST /sales` exige `currency: "MXN"`; no hay multi-moneda.
- **Porcentajes**: puntos base enteros (*basis points*). Campos: `rateBps`, `commissionRateBps` (en Member), `defaultCommissionRateBps` (en la configuración global). `1 bp = 0.01 %`, `1000 = 10.00 %`, `10000 = 100.00 %`. Rango permitido `0..10000`. Nunca floats.
- Ejemplo real de los tests (`test/commissions.e2e-spec.ts:206-208`): `totalSoldMinor: 10000` ($100.00) con `rateBps: 1000` (10 %) da `commissionMinor: 1000` ($10.00). Ejemplo construido a partir del servicio: `333` centavos al `1500` bps son 49.95 centavos y se redondean *half-up* a `50`.
- El total de una venta o deuda lo calcula **siempre el servidor** con el precio actual del producto; el precio que mande el cliente en una partida se ignora.

Fuente: `src/common/money.ts:4-16`, `src/products/dto/product-price.dto.ts:7-12`, `src/sales/dto/create-sale.dto.ts:23-38,74-79`, `src/commissions/dto/commission.dto.ts:16-44`, `src/commissions/commissions.service.ts:27-34`.

<a id="f-paginacion"></a>
### 1.5 Paginación

Los listados paginados responden `{ "items": [...], "total": <int>, "page": <int>, "limit": <int> }`. `total` es el total de filas que cumplen el filtro (no solo las de la página); `page` empieza en **1**; se devuelven `page` y `limit` ya normalizados (con sus valores por defecto). Página y conteo se leen en la misma transacción (`RepeatableRead`), es decir consistentes entre sí, pero la paginación por offset no es un *snapshot* entre peticiones distintas.

Parámetros por endpoint (todos en query string; `page`/`limit` son enteros, cualquier otro valor es 400; un parámetro **desconocido** también es 400):

| Endpoint | `page` | `limit` | Otros parámetros | Orden |
|---|---|---|---|---|
| `GET /api/v1/products` | 1..1000000, def. 1 | 1..100, def. 20 | `search` (0..200 car., busca en el nombre, sin distinguir mayúsculas), `includeInactive` (bool, def. `false`) | `createdAt` asc, `id` asc (fijo) |
| `GET /api/v1/products/:id/audit` | 1..1000000, def. 1 | 1..100, def. 20 | acepta `search` e `includeInactive` (mismo DTO) pero los **ignora** | `changedAt` asc, `id` asc (fijo) |
| `GET /api/v1/sales` | 1..1000000, def. 1 | 1..100, def. 20 | `status`, `search` (0..200, nombre del vendedor), `sort` (`asc`/`desc`, def. `desc`) | `receivedAt` según `sort`, `id` asc |
| `GET /api/v1/incidencias` | 1..1000000, def. 1 | 1..100, def. 20 | `type`, `resolutionStatus`, `search` (0..200, nombre del vendedor de la venta), `sort` (def. `desc`) | `detectedAt` según `sort`, `id` asc |
| `GET /api/v1/deudas` | 1..1000000, def. 1 | 1..100, def. 20 | `status`, `search` (0..200, nombre del deudor), `sort` (def. `desc`) | `createdAt` según `sort`, `id` asc |

**No están paginados** (devuelven todo): `GET /api/v1/members` (array plano), `GET /api/v1/commissions` y los dos reportes (objeto con `items`, sin `total`/`page`/`limit`).

Fuente: `src/products/dto/product.dto.ts:70-93`, `src/sales/dto/sale-list.dto.ts:17-50`, `src/incidencias/dto/incidencia.dto.ts:13-51`, `src/deudas/dto/deuda-list.dto.ts:13-44`, `src/products/products.service.ts:242-275,372-389`.

<a id="f-venta"></a>
### 1.6 El caso crítico de la venta: 201 con conflicto en el cuerpo

`POST /api/v1/sales` puede responder **201 Created con `status: "rechazada_por_conflicto"` en el cuerpo**. No es un error HTTP: es una venta nueva que se guardó como rechazada porque perdió una carrera real de stock contra otra venta sincronizada al mismo tiempo. **El cliente debe leer siempre `body.status`** además del código HTTP, y no tratar todo 2xx como "venta cobrada".

Enum `status`: `"completada"` | `"rechazada_por_conflicto"`.

Resultados posibles de `POST /api/v1/sales` (tal como está implementado):

| Situación | HTTP | Cuerpo |
|---|---|---|
| Venta nueva válida | **201** | `status: "completada"`, `totalMinor`/`changeMinor` calculados, `items` con las partidas |
| Perdió una **carrera de stock** (el stock alcanzaba al leer, pero otra transacción lo consumió antes de bloquear la fila) | **201** | `status: "rechazada_por_conflicto"`, `totalMinor: null`, `changeMinor: null`, `items: []`, `conflictReason` y `conflictDetectedAt` con valor. No se descontó stock. Se crea además una Incidencia `conflicto_stock` para un socio. |
| Reenvío idempotente de un `id` ya guardado con payload equivalente (completada **o** rechazada) | **200** | El mismo registro ya guardado (mismo cuerpo que el primer intento) |
| Mismo `id` con payload distinto | **409** | `"Sale <id> already exists with different data"` |
| `id` nuevo pero el stock **ya era insuficiente** en la lectura inicial (no hay carrera) | **400** | `"Insufficient stock for product <productId>"`; no se guarda nada ni se crea incidencia |

Consecuencias para el cliente:

- Un stock ya agotado al llegar la venta (p. ej. al sincronizar una cola offline) da **400**, **no** un conflicto persistido. Solo la carrera concurrente produce el 201 con conflicto. El cliente no debe reintentar indefinidamente una venta que devuelve 400.
- No se resuelve automáticamente ningún conflicto (reembolso, reasignación de stock): la revisión es humana desde `GET /api/v1/incidencias`.

**Idempotencia**: no hay header de idempotencia. La clave es el campo **`id` del cuerpo** (UUID generado por el cliente antes de enviar; se recomienda UUIDv7). Reintentar tras un timeout o una respuesta perdida: reenviar **exactamente el mismo `id` y el mismo payload**. Se considera "mismo payload" si coinciden `memberId`, `deviceId`, `currency`, `cashReceivedMinor`, `occurredAt` (comparado como instante) y el conjunto de `{productId, quantity}` (sin importar el orden); el `unitPriceMinor` opcional de cada partida **no** cuenta. Si dudas del resultado, `GET /api/v1/sales/:id` devuelve lo persistido (404 si no llegó a guardarse).

Fuente: `src/sales/sales.controller.ts:50-65`, `src/sales/sales.service.ts:135-173,279-507`, `test/sales-conflict.e2e-spec.ts:112-260`, `doc/reglas-de-negocio.md:73-78,151-153`.

<a id="f-context"></a>
### 1.7 `contextId` y validación estricta

- **`contextId` nunca se envía.** Identifica al negocio (tenant) y se infiere de la cuenta autenticada. Ningún DTO lo acepta.
- **Todos los controladores usan `ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })`.** Un campo desconocido (por ejemplo `contextId`, o `image: "https://..."` al crear un producto) **no se ignora: responde 400**. Aplica al cuerpo, a los query params y a los objetos anidados. Ejemplo:

```json
{
  "message": ["property contextId should not exist"],
  "error": "Bad Request",
  "statusCode": 400
}
```

  En objetos anidados el mensaje lleva el prefijo del camino (p. ej. `deudor.property foo should not exist`, `items.0.property x should not exist`).
- Consecuencia práctica: **no reenvíes objetos completos de respuesta como cuerpo de un PATCH** (traen `id`, `contextId`, `stock`, `createdAt`, ...): todo eso sería 400. Envía solo los campos editables de cada DTO.
- Sí verás `contextId` en las **respuestas** JSON (los servicios devuelven el registro de Prisma tal cual; ver [1.11](#f-crudos)). Es el identificador del propio negocio; el frontend puede ignorarlo.
- `doc/reglas-de-negocio.md` (línea 141) dice que un `contextId` enviado en el body "sería ignorado". **Eso es incorrecto respecto al código actual**: es 400 (lo prueban `test/products.e2e-spec.ts` y `test/auth.e2e-spec.ts`, casos con `contextId` en el body).

Fuente: `src/auth/auth.controller.ts:27-35`, `src/products/products.controller.ts:33-39`, `test/products.e2e-spec.ts:196-213`, `test/auth.e2e-spec.ts:174-186`, `node_modules/@nestjs/common/pipes/validation.pipe.js:234-243`.

<a id="f-errores"></a>
### 1.8 Forma de los errores

Los errores son los de Nest por defecto. Forma general: `{ "statusCode": <n>, "message": <string | string[]>, "error": "<nombre>" }`. `message` puede ser un **string** (errores lanzados por los servicios y guards) o un **array de strings** (fallos de validación de DTO): normaliza siempre con `Array.isArray(message) ? message : [message]`.

| Caso | Ejemplo de cuerpo |
|---|---|
| Validación de DTO (400) | `{ "message": ["unitPriceMinor must be an integer number", "unitPriceMinor must not be less than 0"], "error": "Bad Request", "statusCode": 400 }` |
| `:id` no es UUID (400) | `{ "message": "Validation failed (uuid is expected)", "error": "Bad Request", "statusCode": 400 }` |
| Regla de negocio (400) | `{ "message": "Insufficient stock for product 30000000-0000-4000-8000-000000000001", "error": "Bad Request", "statusCode": 400 }` |
| 401 de un guard | `{ "message": "Unauthorized", "statusCode": 401 }` (sin campo `error`) |
| 403 con mensaje | `{ "message": "Only socios may access this resource", "error": "Forbidden", "statusCode": 403 }` |
| 403 sin mensaje (recheck en transacción) | `{ "message": "Forbidden", "statusCode": 403 }` |
| 404 lanzado por un servicio (`NotFoundException()` sin argumentos) | `{ "message": "Not Found", "statusCode": 404 }` |
| 409 | `{ "message": "Incidencia 5000... is already resolved", "error": "Conflict", "statusCode": 409 }` |
| 413 (imagen > 5 MiB) | `{ "message": "File too large", "error": "Payload Too Large", "statusCode": 413 }` (verificado en vivo) |
| 500 | `{ "statusCode": 500, "message": "Internal server error" }` |
| 413 (body JSON de más de ~100 kb) | `{ "statusCode": 413, "message": "request entity too large" }` (verificado en vivo con un body de ~150 kb) |
| 400 (body que no es JSON válido) | `{ "message": "Unexpected token 'n', \"not json\" is not valid JSON", "error": "Bad Request", "statusCode": 400 }` (el `message` es un string y su texto exacto lo produce el motor de JavaScript) |

Notas: el 404 de una ruta que no existe **depende de dónde caiga** (verificado en vivo): bajo `/api/v1` es JSON (`{ "message": "Cannot GET /api/v1/no-existe", "error": "Not Found", "statusCode": 404 }`); fuera del prefijo (por ejemplo `GET /` o `POST /auth/login` sin `/api/v1`) es una **página HTML** de Express (`<pre>Cannot GET /</pre>`), no JSON. El cliente no debe asumir JSON en cualquier 404. Un recurso de **otro negocio** responde 404 (indistinguible de uno inexistente).

Fuente: `node_modules/@nestjs/common/exceptions/http.exception.js:103-125`, `node_modules/@nestjs/common/pipes/parse-uuid.pipe.js:42`, `src/auth/auth.guard.ts:57,67,73`, `src/auth/context.guard.ts:58-73`, `test/auth.e2e-spec.ts:172`.

<a id="f-ids"></a>
### 1.9 IDs, fechas, zona horaria y enums

**IDs**
- Todos son UUID (strings). Los identificadores creados por el backend usan **UUIDv7** (`createServerId`): producto, auditoría, línea de venta, incidencia, deuda, deudor, abono, solicitud de negocio y el `contextId` de un negocio aprobado. Los `id` de Member y Device provienen del seed (p. ej. `bf030001-0000-4000-8000-000000000001`) o del valor por defecto de la base (UUIDv4).
- El **`id` de una venta lo genera el cliente** (offline-first) y es la clave de idempotencia; se recomienda UUIDv7.
- Los parámetros `:id` de ruta se validan con `ParseUUIDPipe` (cualquier versión de UUID): un valor que no sea UUID es 400 antes de buscar nada.

**Fechas**
- Las respuestas serializan fechas en **ISO 8601 UTC con milisegundos y `Z`**, p. ej. `2026-09-23T12:00:00.000Z`.
- `occurredAt` (venta) debe ser ISO 8601 estricto (`IsISO8601({ strict: true })`); envía un instante completo con `Z` u offset. `from`/`to` de reportes y comisiones aceptan una fecha simple `YYYY-MM-DD` o un instante ISO 8601 completo.
- **Zona horaria de negocio**: fija **UTC-06:00** todo el año (Ciudad de México, sin horario de verano desde 2022). Una fecha simple en `from` significa el inicio de ese día local (`00:00:00.000` UTC-6 = `06:00:00.000Z`); una fecha simple en `to`, el final de ese día local (`23:59:59.999` UTC-6 = `05:59:59.999Z` del día siguiente). Un instante ISO completo se usa tal cual, sin reinterpretarlo. Los límites son inclusivos.
- Las agregaciones (reportes y comisiones) se anclan a **`receivedAt`** (reloj del servidor), no a `occurredAt` (reloj del dispositivo). La semana de comisiones es domingo 00:00 a sábado 23:59:59.999 (hora de negocio).
- Las respuestas de reportes/comisiones devuelven `from` y `to` ya normalizados como instantes UTC.

**Enums** (valores exactos del código)

| Enum | Valores |
|---|---|
| `role` (Member) | `socio`, `colaborador` |
| `tipo` (Product) | `unica`, `cantidad` |
| `status` (Sale) | `completada`, `rechazada_por_conflicto` |
| `type` (Incidencia) | `conflicto_stock`, `incidencia_fecha` |
| `resolutionStatus` (Incidencia) | `pendiente`, `resuelta` |
| `type` (Deuda) | `fiado`, `apartado` |
| `status` (Deuda) | `pendiente`, `saldada` |
| `status` (BusinessRegistration) | `pendiente`, `aprobado`, `rechazado` |
| `currency` | `MXN` (único aceptado) |
| `sort` (listados) | `asc`, `desc` |

Fuente: `src/common/server-id.ts:10-12`, `src/common/business-time.ts:19-100`, `src/sales/dto/create-sale.dto.ts:70`, `prisma/schema.prisma:11-41`.

<a id="f-cors"></a>
### 1.10 CORS

Hechos verificados en el código (`rg enableCors src` no devuelve nada; `main.ts` no configura CORS ni hay `cors` en `src/`):

- El backend **no habilita CORS**: no envía ningún header `Access-Control-*` y no responde a preflight (`OPTIONS`). Verificado en vivo: `OPTIONS /api/v1/auth/login` con `Origin: http://localhost:5173` y `Access-Control-Request-Method: POST` da `404 { "message": "Cannot OPTIONS /api/v1/auth/login", "error": "Not Found", "statusCode": 404 }` y ningún header `Access-Control-*`.
- Por tanto, una llamada desde el navegador a un origen distinto del de la API (por ejemplo `http://localhost:5173` -> `http://localhost:3000`) **queda bloqueada por el navegador**. Esto vale tanto para peticiones "simples" como para las que llevan `Authorization`, `x-member-id`, `x-device-id` o `Content-Type: application/json` (todas provocan preflight).
- **Desarrollo**: usar el proxy de Vite. `bazar-frontend/vite.config.ts` ya proxea `/api` a `http://localhost:3000` (`changeOrigin: true`). Para que funcione, `VITE_API_URL` debe ser **relativa** (`/api/v1`); en `src/services/api.ts` el valor por defecto ya es `'/api/v1'`. Ojo: `bazar-frontend/.env.example` (2026-09-24) propone `VITE_API_URL=http://localhost:3000/api/v1`, un valor **absoluto** que saltaría el proxy y sería bloqueado por CORS; no lo copies tal cual a `.env`.
- **Imágenes en desarrollo**: el proxy de Vite solo cubre `/api`, pero las imágenes de producto se sirven desde `/uploads/products/...` (fuera del prefijo). Hay que añadir también un proxy para `/uploads` en `vite.config.ts` (no está configurado hoy).
- **Producción**: o se sirven frontend y API bajo el **mismo origen** (por ejemplo un reverse proxy que enruta `/api` y `/uploads` al backend y el resto a los estáticos del frontend), o hay que **configurar CORS en el backend antes de desplegar** (no existe configuración hoy y este documento no propone una).

Fuente: `src/main.ts:7-20`, `bazar-frontend/vite.config.ts` (`server.proxy`), `bazar-frontend/src/services/api.ts:6`, `bazar-frontend/.env.example:2`.

<a id="f-crudos"></a>
### 1.11 Respuestas con registros crudos

Los servicios devuelven el registro de Prisma tal cual, sin capa de DTO de respuesta. Por eso las respuestas incluyen campos internos que el frontend puede ignorar:

- `contextId` en Member, Product, ProductAudit, Sale, Incidencia, Deuda, Deudor, Abono y AppSettings (no en las respuestas de `GET /members`, que hace un `select` de `id/name/role/active`, ni en los `items` de venta).
- `Sale.requestFingerprint`: hash sha256 (hex) interno del payload (`null` en ventas históricas antiguas). No sirve para nada en el frontend.
- Producto: **no** se devuelve `imagePath` (clave interna de almacenamiento); se devuelve `image` (ruta pública o `null`). Pero los snapshots `before`/`after` de `GET /products/:id/audit` **sí** contienen `imagePath`.
- Los flags `active` (Product, Member) sí aparecen.

---

<a id="mod-auth"></a>
## 2. Auth

Un único endpoint público: el login de la **cuenta** del negocio (una cuenta compartida por la tablet, no un login por persona). Solo emite el JWT; elegir quién atiende y desde qué dispositivo es un paso aparte (ver [1.3](#f-auth)). Las cuentas y los dispositivos se crean fuera de banda (seed); **no existe endpoint de registro de cuentas**. Ante credenciales inválidas, cuenta desactivada o usuario inexistente el backend responde exactamente igual (no revela si el usuario existe).

<a id="ep-auth-login"></a>
### `POST /api/v1/auth/login`

| | |
|---|---|
| Audiencia | Pública (sin token, sin headers de selección) |
| Headers | `Content-Type: application/json` |
| Éxito | **200** (no 201) |

**Body** (JSON, propiedades desconocidas = 400):

| Campo | Tipo | Reglas |
|---|---|---|
| `username` | string | requerido, 1..100 caracteres |
| `password` | string | requerido, 1..256 caracteres |

**Respuesta 200**:

| Campo | Tipo | Notas |
|---|---|---|
| `accessToken` | string | JWT HS256 |
| `tokenType` | string | siempre `"Bearer"` |
| `expiresIn` | integer | segundos; `43200` (12 h) |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Falta un campo, tipo incorrecto (p. ej. `username: 12`), longitud fuera de rango o campo desconocido (p. ej. `contextId`) | array, p. ej. `["username must be a string", "username must be longer than or equal to 1 characters"]` |
| 401 | Usuario inexistente, contraseña incorrecta o cuenta desactivada (indistinguibles) | `"Invalid credentials"` |

**Ejemplo** (valores ficticios)

```json
{ "username": "socio@example.test", "password": "REPLACE_WITH_ACCOUNT_PASSWORD" }
```

```json
{ "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 43200 }
```

Fuente: `src/auth/auth.controller.ts:14-38` (DTO `LoginDto` L14-17, `@HttpCode(200)` L25), `src/auth/auth.service.ts:40-58`, `src/auth/jwt.constants.ts:7`, `test/auth.e2e-spec.ts:150-186`.

---

<a id="mod-members"></a>
## 3. Members

Los Members son las personas del negocio: `socio` (administra todo) y `colaborador` (vende y consulta el catálogo). Reglas que importan al frontend:

- Un Member pertenece a un solo negocio (`contextId`); nunca se ven Members de otro negocio.
- **No hay endpoint para crear Members** (se siembran o nacen al aprobar un negocio nuevo). Solo se listan, se renombran, se ajusta su comisión y se (des)activan.
- El selector de persona usa `GET /members` **antes** de tener member/device elegidos, por eso solo exige token.
- **Borrado lógico**: `DELETE /members/:id` no borra, pone `active: false`. Un colaborador inactivo desaparece del listado por defecto y ya no puede ser elegido como quien atiende (`ContextGuard` lo rechaza con 403), pero su historial (ventas, comisiones, incidencias, deudas, abonos) queda intacto. Un **socio no se puede desactivar** (400). Se puede reactivar.
- `includeInactive=true` solo se respeta cuando el request lleva `x-member-id` de un **socio activo del mismo negocio**; en cualquier otro caso se **ignora en silencio** (no da error).
- La comisión individual de un Member (`commissionRateBps`, puntos base) solo aplica a colaboradores; se ajusta con `PATCH /members/:id` o con [`PATCH /members/:id/commission-rate`](#ep-members-commission-rate) (documentado en Commissions).

Forma de un Member completo (respuestas de `PATCH`/`DELETE`/reactivate/commission-rate; registro crudo):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (UUID) | |
| `name` | string | |
| `role` | `"socio"` \| `"colaborador"` | |
| `contextId` | string | ignorable |
| `createdAt` | string (ISO 8601) | |
| `active` | boolean | |
| `commissionRateBps` | integer \| null | override individual; `null` = usa la tasa global |

<a id="ep-members-list"></a>
### `GET /api/v1/members`

| | |
|---|---|
| Audiencia | Cuenta autenticada; cualquier Member (solo `AuthGuard`) |
| Headers | `Authorization`. `x-member-id` **opcional** (solo para `includeInactive`); `x-device-id` **no** requerido |
| Éxito | **200**, **array plano** (sin paginación) |

**Query** (cualquier otro parámetro = 400):

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `includeInactive` | boolean (`true`/`false`) | `false` | Solo el texto exacto `true` activa; cualquier otro valor (`1`, `yes`) cuenta como `false`. Se respeta únicamente si `x-member-id` es un socio activo del negocio |

**Respuesta**: array ordenado por `name` asc y luego `id`; cada elemento `{ id, name, role, active }` (**sin** `contextId` ni `commissionRateBps`).

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Query param desconocido o `includeInactive` no booleano válido | array de validación |
| 401 | Token ausente/inválido/expirado | `"Unauthorized"` |

**Ejemplo**

```http
GET /api/v1/members HTTP/1.1
Authorization: Bearer eyJ...
```

```json
[
  { "id": "bf030001-0000-4000-8000-000000000002", "name": "Adid", "role": "socio", "active": true },
  { "id": "bf030001-0000-4000-8000-000000000001", "name": "Alberto", "role": "socio", "active": true },
  { "id": "10000000-0000-4000-8000-000000000003", "name": "Carlos", "role": "colaborador", "active": true }
]
```

Fuente: `src/members/members.controller.ts:58-71`, `src/members/members.service.ts:89-105`, `src/members/dto/member.dto.ts:48-65`, `src/auth/socio-check.util.ts:24-39`, `test/auth.e2e-spec.ts:212-224`, `test/soft-delete.e2e-spec.ts:512-560`.

<a id="ep-members-patch"></a>
### `PATCH /api/v1/members/:id`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, Member completo actualizado |

**Path**: `id` UUID del Member a editar.

**Body** (todos opcionales, pero **al menos uno** es obligatorio):

| Campo | Tipo | Reglas |
|---|---|---|
| `name` | string | 1..200 caracteres y con al menos un carácter no blanco. No admite `null` |
| `commissionRateBps` | integer \| null | 0..10000 puntos base; `null` borra el override (vuelve a la tasa global). **Rechazado con 400 si el Member destino es socio, incluso enviando `null`** |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no es UUID | `"Validation failed (uuid is expected)"` |
| 400 | Body vacío `{}` o sin campos editables | `"At least one editable field is required"` |
| 400 | `commissionRateBps` enviado (aunque sea `null`) y el destino es `socio` | `"commissionRateBps does not apply to a socio"` |
| 400 | Validación (nombre en blanco, tasa fuera de rango o decimal, campo desconocido) | array de validación |
| 401 / 403 | Sin token / selección inválida / no es socio | ver [1.3](#f-auth) |
| 404 | El Member no existe en este negocio | `"Not Found"` |

**Ejemplo**

```json
{ "name": "Carlos Ruiz", "commissionRateBps": 1000 }
```

```json
{
  "id": "10000000-0000-4000-8000-000000000003",
  "name": "Carlos Ruiz",
  "role": "colaborador",
  "contextId": "bazar-local",
  "createdAt": "2026-09-23T12:00:00.000Z",
  "active": true,
  "commissionRateBps": 1000
}
```

(ejemplo construido a partir del DTO y del registro `Member`).

Fuente: `src/members/members.controller.ts:88-103`, `src/members/dto/member.dto.ts:23-46`, `src/members/members.service.ts:120-145`, `test/soft-delete.e2e-spec.ts:489-511`.

<a id="ep-members-delete"></a>
### `DELETE /api/v1/members/:id`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200** con el Member ya desactivado (**no** 204, **con cuerpo**) |

Desactiva (borrado lógico, `active: false`) a un colaborador. **Idempotente**: desactivar uno que ya está inactivo devuelve 200 con el estado actual, no un 409. No lleva body.

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no es UUID | `"Validation failed (uuid is expected)"` |
| 400 | El destino es un socio | `"No se puede desactivar a un socio"` |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | El Member no existe en este negocio | `"Not Found"` |

**Ejemplo** (construido a partir del servicio)

```http
DELETE /api/v1/members/10000000-0000-4000-8000-000000000003 HTTP/1.1
```

```json
{
  "id": "10000000-0000-4000-8000-000000000003",
  "name": "Carlos",
  "role": "colaborador",
  "contextId": "bazar-local",
  "createdAt": "2026-09-23T12:00:00.000Z",
  "active": false,
  "commissionRateBps": null
}
```

Fuente: `src/members/members.controller.ts:105-121`, `src/members/members.service.ts:170-183`, `test/soft-delete.e2e-spec.ts:359-471`.

<a id="ep-members-reactivate"></a>
### `PATCH /api/v1/members/:id/reactivate`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, Member completo con `active: true` |

Sin body. Idempotente: reactivar uno ya activo devuelve 200 con el estado actual.

**Errores**: 400 (`:id` no UUID), 401/403 (ver [1.3](#f-auth)), 404 `"Not Found"` si no existe en este negocio.

**Ejemplo**: misma forma que la respuesta de `DELETE`, con `"active": true`.

Fuente: `src/members/members.controller.ts:123-134`, `src/members/members.service.ts:193-204`.

`PATCH /api/v1/members/:id/commission-rate` pertenece al controlador de Members pero se documenta en [Commissions](#ep-members-commission-rate).

---

<a id="mod-devices"></a>
## 4. Devices

Los dispositivos son las tablets/teléfonos autorizados. **No se auto-registran**: existen previamente (seed) y deben estar `authorized`. Este endpoint solo traduce el `identifier` estable del dispositivo a su `id` interno, que luego se envía como `x-device-id`. Un dispositivo revocado deja de servir de inmediato (el `ContextGuard` lo rechaza con 403). No hay endpoint para listar ni crear dispositivos.

Dispositivos sembrados por `prisma/seed-data.ts` para el negocio de desarrollo: `identifier: "shared-tablet"` (`name: "Shared tablet"`), `"alberto-backup-phone"` (`"Alberto backup phone"`) y `"adid-backup-phone"` (`"Adid backup phone"`).

<a id="ep-devices-identify"></a>
### `POST /api/v1/devices/identify`

| | |
|---|---|
| Audiencia | Cuenta autenticada (solo `AuthGuard`) |
| Headers | `Authorization`. `x-member-id`/`x-device-id` **no** requeridos |
| Éxito | **200** (no 201) |

**Body**:

| Campo | Tipo | Reglas |
|---|---|---|
| `identifier` | string | requerido, 1..100. Identificador estable asignado fuera de banda (no el `id` interno) |
| `name` | string | requerido, 1..100. Debe coincidir **exactamente** con el nombre registrado |

**Respuesta 200**: `{ "deviceId": "<uuid>" }`.

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Campo faltante, vacío, demasiado largo o desconocido | array de validación |
| 401 | Token ausente/inválido/expirado | `"Unauthorized"` |
| 403 | No existe un dispositivo con ese `identifier`+`name` en el negocio de la cuenta, o existe pero no está autorizado, o pertenece a otro negocio | `"Device is unknown or unauthorized"` |

**Ejemplo** (`test/auth.e2e-spec.ts:225-251`)

```json
{ "identifier": "shared-tablet", "name": "Shared tablet" }
```

```json
{ "deviceId": "20000000-0000-4000-8000-000000000001" }
```

Fuente: `src/devices/devices.controller.ts:18-72` (guard L42, `@HttpCode(200)` L47), `prisma/seed-data.ts:185-207`, `test/auth.e2e-spec.ts:225-251`.

---

<a id="mod-products"></a>
## 5. Products

Catálogo del negocio. Reglas de negocio que importan al frontend:

- Un producto es `unica` (pieza única) o `cantidad`. Una `unica` **siempre nace con stock 1**, aunque se envíe otro `initialStock`; al venderse pasa a 0. No existe un estado "vendido": se infiere de `stock === 0` (el frontend suele mostrarlo en gris y deshabilitarlo). Un producto `cantidad` exige `initialStock`.
- **Lectura**: cualquier cuenta autenticada (incluidos colaboradores). **Escritura** (crear, editar, imagen, desactivar, reactivar): solo socios.
- `tipo`, `initialStock` y `stock` **no se editan** por la API de productos: `stock` solo cambia con ventas y deudas.
- **Borrado lógico**: `DELETE /products/:id` pone `active: false`; el producto desaparece del listado por defecto y ya no se puede vender ni usar en una deuda (400), pero sigue existiendo y `GET /products/:id` lo devuelve igual. Se puede reactivar. Su `stock` no se toca.
- `includeInactive=true` en el listado solo se respeta si el request lleva `x-member-id` de un **socio activo**; si no, se ignora en silencio.
- Cada creación, edición y subida de imagen escribe una fila de **auditoría** (quién, cuándo, valores anterior y nuevo). Desactivar/reactivar **no** audita.
- Las imágenes se suben como archivo real (multipart) por un endpoint aparte; no se acepta una URL de texto.

Forma de un producto en las respuestas:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (UUIDv7) | |
| `name` | string | |
| `tipo` | `"unica"` \| `"cantidad"` | |
| `unitPriceMinor` | integer | centavos MXN |
| `contextId` | string | ignorable |
| `initialStock` | integer | |
| `stock` | integer | existencia actual |
| `category` | string \| null | |
| `purchaseCostMinor` | integer \| null | costo de compra, centavos |
| `supplier` | string \| null | |
| `notes` | string \| null | |
| `createdAt` | string (ISO 8601) | |
| `active` | boolean | |
| `image` | string \| null | ruta pública `/uploads/products/<uuid>.png` (ver [1.2](#f-montajes)); **no** existe `imagePath` en la respuesta |

<a id="ep-products-create"></a>
### `POST /api/v1/products`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **201**, el producto creado |

**Body**:

| Campo | Tipo | Reglas |
|---|---|---|
| `name` | string | requerido, 1..200, con algún carácter no blanco |
| `tipo` | `"unica"` \| `"cantidad"` | requerido |
| `unitPriceMinor` | integer | requerido, 0..2147483647 (centavos) |
| `initialStock` | integer | **requerido si `tipo` es `cantidad`** (0..2147483647). Para `unica` es opcional y se **ignora** (siempre 1), pero si se envía se valida igual (un valor negativo o > 2147483647 sigue siendo 400) |
| `category` | string \| null | opcional, 1..100 |
| `purchaseCostMinor` | integer \| null | opcional, 0..2147483647 |
| `supplier` | string \| null | opcional, 1..200 |
| `notes` | string \| null | opcional, 0..2000 |

`image`, `stock`, `active`, `contextId` u otros campos = 400.

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Validación: `unitPriceMinor` decimal (`125.5`) o negativo, `tipo` fuera del enum, nombre en blanco, `cantidad` sin `initialStock`, `initialStock` negativo, campo desconocido (`contextId`, `image`) | array de validación |
| 401 / 403 | ver [1.3](#f-auth) (un colaborador recibe 403 `"Only socios may access this resource"`) | |

**Ejemplo** (basado en `test/products.e2e-spec.ts` y las fixtures de `src/docs/bazaar-examples.ts`)

```json
{
  "name": "Marvel’s Spider-Man 2 — PS5",
  "tipo": "unica",
  "unitPriceMinor": 125000,
  "category": "PS5 physical games",
  "purchaseCostMinor": 90000,
  "supplier": "Local trade-in",
  "notes": "Used disc and original case, tested."
}
```

```json
{
  "id": "30000000-0000-4000-8000-000000000001",
  "name": "Marvel’s Spider-Man 2 — PS5",
  "tipo": "unica",
  "unitPriceMinor": 125000,
  "contextId": "bazar-local",
  "initialStock": 1,
  "stock": 1,
  "category": "PS5 physical games",
  "purchaseCostMinor": 90000,
  "supplier": "Local trade-in",
  "notes": "Used disc and original case, tested.",
  "createdAt": "2026-09-23T12:00:00.000Z",
  "active": true,
  "image": null
}
```

Fuente: `src/products/products.controller.ts:56-64`, `src/products/dto/product.dto.ts:25-52`, `src/products/dto/product-price.dto.ts:7-12`, `src/products/products.service.ts:51-59,144-166`, `test/products.e2e-spec.ts:170-213`.

<a id="ep-products-list"></a>
### `GET /api/v1/products`

| | |
|---|---|
| Audiencia | Cuenta autenticada; cualquier Member (solo `AuthGuard`) |
| Headers | `Authorization`. `x-member-id` **opcional** (solo para `includeInactive`); `x-device-id` no requerido |
| Éxito | **200**, `{ items, total, page, limit }` |

**Query** (desconocidos = 400): `search` (0..200; coincidencia parcial sin distinguir mayúsculas en `name`), `includeInactive` (`true`/`false`, def. `false`), `page` (1..1000000, def. 1), `limit` (1..100, def. 20). Orden fijo: `createdAt` asc, `id` asc. Por defecto solo productos `active: true`; los de `stock: 0` **sí** aparecen.

**Errores**: 400 (`page`/`limit` no enteros o fuera de rango, p. ej. `limit=101`, parámetro desconocido); 401.

**Ejemplo**

```http
GET /api/v1/products?search=PS5&page=1&limit=20 HTTP/1.1
Authorization: Bearer eyJ...
```

```json
{
  "items": [
    {
      "id": "30000000-0000-4000-8000-000000000002",
      "name": "God of War Ragnarök — PS5",
      "tipo": "cantidad",
      "unitPriceMinor": 85000,
      "contextId": "bazar-local",
      "initialStock": 3,
      "stock": 3,
      "category": "PS5 physical games",
      "purchaseCostMinor": 60000,
      "supplier": "Local trade-in",
      "notes": null,
      "createdAt": "2026-09-23T12:00:00.000Z",
      "active": true,
      "image": null
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

Fuente: `src/products/products.controller.ts:75-84`, `src/products/dto/product.dto.ts:70-93`, `src/products/products.service.ts:242-275`, `test/soft-delete.e2e-spec.ts:283-330`.

<a id="ep-products-get"></a>
### `GET /api/v1/products/:id`

| | |
|---|---|
| Audiencia | Cuenta autenticada; cualquier Member (solo `AuthGuard`) |
| Headers | `Authorization` |
| Éxito | **200**, un producto |

Devuelve el producto **aunque esté desactivado** (`active: false`); solo el listado por defecto lo oculta. No tiene query params.

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no es UUID | `"Validation failed (uuid is expected)"` |
| 401 | sin token | `"Unauthorized"` |
| 404 | No existe en este negocio (un producto de otro negocio es indistinguible) | `"Not Found"` |

Ejemplo: misma forma que el objeto de la respuesta de creación.

Fuente: `src/products/products.controller.ts:85-99`, `src/products/products.service.ts:288-294`.

<a id="ep-products-patch"></a>
### `PATCH /api/v1/products/:id`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, el producto actualizado |

Edita nombre, precio y metadatos. **Al menos un campo** es obligatorio. Cada PATCH exitoso escribe una fila de auditoría (aunque el valor enviado sea igual al actual).

**Body** (todos opcionales):

| Campo | Tipo | Reglas |
|---|---|---|
| `name` | string | 1..200, algún carácter no blanco. No admite `null` |
| `unitPriceMinor` | integer | 0..2147483647. **`null` es 400** (no se puede "borrar" el precio) |
| `category` | string \| null | 1..100; `null` lo borra |
| `purchaseCostMinor` | integer \| null | 0..2147483647; `null` lo borra |
| `supplier` | string \| null | 1..200; `null` lo borra |
| `notes` | string \| null | 0..2000; `null` lo borra |

`tipo`, `initialStock`, `stock`, `image`, `active`, `id`, `contextId` y cualquier otro campo = **400** (inmutables o inexistentes en el DTO).

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 400 | Body vacío `{}` | `"At least one editable field is required"` |
| 400 | `tipo`/`stock`/`initialStock`/`unitPriceMinor: null`, decimales, campo desconocido | array de validación |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | Producto inexistente en este negocio | `"Not Found"` |

**Ejemplo** (`test/products.e2e-spec.ts:214-247`)

```json
{ "unitPriceMinor": 120000, "notes": "Edited" }
```

Respuesta: el producto completo con `"unitPriceMinor": 120000` y `"notes": "Edited"`.

Fuente: `src/products/products.controller.ts:65-74`, `src/products/dto/product.dto.ts:17-23,54-68`, `src/products/products.service.ts:179-218`, `test/products.e2e-spec.ts:214-247`.

<a id="ep-products-audit"></a>
### `GET /api/v1/products/:id/audit`

| | |
|---|---|
| Audiencia | Cuenta autenticada; cualquier Member (solo `AuthGuard`; los colaboradores pueden leer el historial) |
| Headers | `Authorization` |
| Éxito | **200**, `{ items, total, page, limit }` |

Historial de auditoría del producto, del más antiguo al más nuevo (`changedAt` asc, `id` asc; no se puede cambiar el orden). Query: `page` (def. 1), `limit` (def. 20, máx. 100). Acepta también `search` e `includeInactive` (mismo DTO que el listado) pero los **ignora**.

Cada elemento (registro crudo):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `productId` | string | |
| `memberId` | string | socio que hizo el cambio |
| `contextId` | string | ignorable |
| `changedAt` | string (ISO 8601) | |
| `oldUnitPriceMinor` | integer \| null | `null` en la creación |
| `newUnitPriceMinor` | integer | |
| `before` | objeto \| null | snapshot previo; `null` en la creación |
| `after` | objeto | snapshot posterior con `name, tipo, unitPriceMinor, initialStock, stock, imagePath, category, purchaseCostMinor, supplier, notes` (`imagePath` es la clave interna, no una URL) |

**Errores**: 400 (`:id` no UUID, query inválida), 401, 404 `"Not Found"` (producto inexistente o de otro negocio).

**Ejemplo** (construido a partir del servicio; valores de `bazaar-examples.ts`, añadiendo `contextId`)

```json
{
  "items": [
    {
      "id": "90000000-0000-4000-8000-000000000001",
      "productId": "30000000-0000-4000-8000-000000000001",
      "memberId": "bf030001-0000-4000-8000-000000000001",
      "contextId": "bazar-local",
      "changedAt": "2026-09-23T12:30:00.000Z",
      "oldUnitPriceMinor": 125000,
      "newUnitPriceMinor": 120000,
      "before": { "name": "Marvel’s Spider-Man 2 — PS5", "tipo": "unica", "unitPriceMinor": 125000, "initialStock": 1, "stock": 1, "imagePath": null, "category": "PS5 physical games", "purchaseCostMinor": 90000, "supplier": "Local trade-in", "notes": null },
      "after": { "name": "Marvel’s Spider-Man 2 — PS5", "tipo": "unica", "unitPriceMinor": 120000, "initialStock": 1, "stock": 1, "imagePath": null, "category": "PS5 physical games", "purchaseCostMinor": 90000, "supplier": "Local trade-in", "notes": null }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

Fuente: `src/products/products.controller.ts:100-109`, `src/products/products.service.ts:28-41,110-130,372-389`.

<a id="ep-products-image"></a>
### `POST /api/v1/products/:id/image`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id`. `Content-Type: multipart/form-data` (con Axios, pasa un `FormData` y deja que el navegador ponga el `boundary`; no fuerces `application/json`) |
| Éxito | **201**, el producto con `image` actualizado |

**Body multipart**: exactamente **un** archivo en el campo llamado **`image`** y **ningún otro campo** (el servidor rechaza cualquier campo de formulario adicional). Reglas de archivo:

- Tamaño máximo **5 MiB** (5 242 880 bytes).
- Formatos aceptados: PNG, JPEG o WebP reales. El `Content-Type` declarado de la parte (`image/png`, `image/jpeg`, `image/webp`) debe coincidir con el formato real de los bytes (se valida firma y decodificación); SVG, HTML, GIF animado o un archivo renombrado se rechazan.
- Imagen de un solo fotograma y hasta 16 millones de píxeles decodificados.
- El servidor **reencoda siempre a PNG** con un nombre aleatorio; el nombre de archivo enviado se descarta.
- Reemplazar la imagen crea una nueva URL; el archivo anterior **no se borra** y sigue accesible por su URL vieja (lo muestra `test/products.e2e-spec.ts:404`). Cada subida escribe una fila de auditoría.

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 400 | No se envió el archivo | `"Image is required"` |
| 400 | Firma de bytes no soportada (SVG, HTML, truncado) | `"Unsupported image signature"` |
| 400 | Decodificación fallida, MIME declarado distinto del real, animada, > 16 M píxeles o resultado > 5 MiB | `"Invalid, unsupported or oversized decoded image"` |
| 400 | Campo de archivo con otro nombre distinto de `image` (verificado en vivo con `foto`) | `"Unexpected file field - foto"` |
| 400 | Campo de formulario extra además del archivo | `"Too many fields"` |
| 400 | Más de un archivo | `"Too many files"` |
| 401 / 403 | ver [1.3](#f-auth). El 403 se evalúa **antes** de leer el archivo | |
| 404 | Producto inexistente en este negocio (se comprueba antes de validar el archivo) | `"Not Found"` |
| 413 | Archivo > 5 MiB | `"File too large"` (`error: "Payload Too Large"`) |

**Ejemplo** (Axios, construido a partir del controlador)

```ts
const form = new FormData()
form.append('image', fileInput.files[0]) // único campo, nombre exacto "image"
await api.post(`/products/${productId}/image`, form, {
  headers: { 'x-member-id': memberId, 'x-device-id': deviceId },
})
```

```json
{
  "id": "30000000-0000-4000-8000-000000000001",
  "name": "Marvel’s Spider-Man 2 — PS5",
  "tipo": "unica",
  "unitPriceMinor": 125000,
  "contextId": "bazar-local",
  "initialStock": 1,
  "stock": 1,
  "category": "PS5 physical games",
  "purchaseCostMinor": 90000,
  "supplier": "Local trade-in",
  "notes": null,
  "createdAt": "2026-09-23T12:00:00.000Z",
  "active": true,
  "image": "/uploads/products/91000000-0000-4000-8000-000000000001.png"
}
```

Fuente: `src/products/products.controller.ts:110-127`, `src/products/products.service.ts:401-421`, `src/storage/storage.service.ts:11,39-41,69-124`, `test/products.e2e-spec.ts:365-446`.

<a id="ep-products-delete"></a>
### `DELETE /api/v1/products/:id`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200** con el producto desactivado (`active: false`), **con cuerpo** |

Borrado lógico. No lleva body. **Idempotente**: desactivar uno ya inactivo devuelve 200 con el estado actual. No modifica `stock` ni escribe auditoría. Después de desactivar, `POST /sales` y `POST /deudas` que lo incluyan responden 400 (`"Product <id> is deactivated and cannot be sold"` / `"... cannot be used for a new deuda"`).

**Errores**: 400 (`:id` no UUID), 401/403 (ver [1.3](#f-auth)), 404 `"Not Found"`.

Ejemplo de respuesta: el objeto producto con `"active": false`.

Fuente: `src/products/products.controller.ts:128-142`, `src/products/products.service.ts:320-335`, `test/soft-delete.e2e-spec.ts:175-282`.

<a id="ep-products-reactivate"></a>
### `PATCH /api/v1/products/:id/reactivate`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, el producto con `active: true` |

Sin body. Idempotente. Errores: 400 (`:id` no UUID), 401/403, 404 `"Not Found"`. Ejemplo de respuesta: el objeto producto con `"active": true`.

Fuente: `src/products/products.controller.ts:143-156`, `src/products/products.service.ts:349-364`.

---

<a id="mod-sales"></a>
## 6. Sales

Venta presencial, al contado, multi-producto. Reglas que importan al frontend (detalle del caso crítico en [1.6](#f-venta)):

- **Cualquier Member activo** (socio o colaborador) puede registrar una venta (`ContextGuard`). **Ver el historial completo** (`GET /sales`, "movimientos") es solo de socios. Cualquier cuenta autenticada puede releer **una** venta si conoce su `id` (`GET /sales/:id`).
- El servidor calcula **siempre** el total con el precio *actual* del catálogo; el `unitPriceMinor` opcional de cada partida es solo trazabilidad del cliente y se ignora para cobrar.
- La venta es **atómica**: si una partida falla (producto inexistente o de otro negocio, desactivado, stock insuficiente, efectivo insuficiente), se rechaza toda la venta y no se descuenta nada. Las partidas se procesan en orden, así que un mismo `productId` repetido en varias partidas ve los descuentos de las anteriores. Una `unica` con `quantity > 1` da 400 (su stock es 1).
- Descuento de stock: `unica` pasa de 1 a 0; `cantidad` resta `quantity`.
- No hay fiado ni pago parcial en este endpoint: `cashReceivedMinor` menor al total = 400. Para crédito/apartado ver [Deudas](#mod-deudas).
- **La fecha no bloquea**: si `occurredAt` es posterior a la hora del servidor (aunque sea por milisegundos) o anterior por más de 2 días, la venta se guarda igual como `completada` y se crea una Incidencia `incidencia_fecha` para revisión de un socio (esa incidencia **no** aparece en la respuesta de la venta). Un reloj del dispositivo adelantado genera incidencias.
- `memberId` y `deviceId` del body **deben coincidir** con `x-member-id`/`x-device-id`; si no, 403.
- No hay descuentos ni cancelaciones (no implementados).

Forma de una venta en las respuestas (`POST /sales`, `GET /sales`, `GET /sales/:id`):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (UUID) | el que mandó el cliente |
| `memberId` | string | quien vendió |
| `deviceId` | string | |
| `contextId` | string | ignorable |
| `occurredAt` | string (ISO 8601) | fecha declarada por el cliente |
| `receivedAt` | string (ISO 8601) | reloj del servidor; ancla de reportes y comisiones |
| `currency` | string | `"MXN"` |
| `status` | `"completada"` \| `"rechazada_por_conflicto"` | **leerlo siempre** |
| `totalMinor` | integer \| null | `null` si está rechazada |
| `cashReceivedMinor` | integer | |
| `changeMinor` | integer \| null | cambio; `null` si está rechazada |
| `requestFingerprint` | string \| null | hash interno, ignorable |
| `conflictReason` | string \| null | solo en rechazadas, p. ej. `"stock insuficiente al sincronizar: producto <id>, solicitado 1, disponible 0"` |
| `conflictDetectedAt` | string \| null | solo en rechazadas |
| `items` | array | `[]` en rechazadas. Cada elemento: `{ id, productId, quantity, unitPriceMinor, subtotalMinor, createdAt }` (`unitPriceMinor` es el precio cobrado, no el enviado) |

<a id="ep-sales-create"></a>
### `POST /api/v1/sales`

| | |
|---|---|
| Audiencia | Cualquier Member activo con dispositivo autorizado (`ContextGuard`) |
| Headers | `Authorization`, `x-member-id`, `x-device-id` (obligatorios; deben coincidir con `memberId`/`deviceId` del body) |
| Éxito | **201** venta nueva (completada **o** rechazada por conflicto); **200** reenvío idempotente |

**Body** (propiedades desconocidas, también dentro de `items`, = 400):

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | string (UUID) | requerido; lo genera el cliente; clave de idempotencia (recomendado UUIDv7) |
| `memberId` | string (UUID) | requerido; igual a `x-member-id` |
| `deviceId` | string (UUID) | requerido; igual a `x-device-id` |
| `occurredAt` | string | requerido; ISO 8601 estricto. Envía el instante completo (`2026-09-23T12:00:00.000Z`). Una fecha simple (`2026-09-23`) también se acepta y se guarda como `2026-09-23T00:00:00.000Z` (verificado en vivo) |
| `currency` | string | requerido; solo `"MXN"` |
| `cashReceivedMinor` | integer | requerido; 0..2147483647 (centavos) |
| `items` | array | requerido; 1..500 elementos |
| `items[].productId` | string (UUID) | requerido |
| `items[].quantity` | integer | requerido; 1..100000 |
| `items[].unitPriceMinor` | integer | opcional; 0..2147483647; **ignorado** para el cobro y para la comparación de idempotencia |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Validación: `items` vacío o > 500, `quantity` < 1 o decimal, `currency` distinta de `MXN`, UUID inválido, campo desconocido | array de validación |
| 400 | Un `productId` no existe en el negocio (o es de otro negocio) | `"Product <id> does not exist in this context"` |
| 400 | Producto desactivado | `"Product <id> is deactivated and cannot be sold"` |
| 400 | `quantity` mayor al stock ya visible al inicio (para `unica`, cualquier cantidad > 1) | `"Insufficient stock for product <id>"` |
| 400 | `cashReceivedMinor` menor al total calculado | `"Cash received is insufficient for the calculated total"` |
| 401 | Token ausente/inválido/expirado | `"Unauthorized"` |
| 403 | Faltan/son inválidos los headers, o el Member/Device no está autorizado en el negocio | `"Valid member and device selection required"` / `"Selection is not authorized for this context"` |
| 403 | `memberId`/`deviceId` del body distinto de los headers | `"Sale attribution must match the authenticated selection"` |
| 409 | El `id` ya existe con datos distintos | `"Sale <id> already exists with different data"` |

Notas de comportamiento:

- **201 con `status: "rechazada_por_conflicto"`** ver [1.6](#f-venta). No es un error HTTP.
- **200** solo en reenvío idempotente; el cuerpo es el registro ya guardado.
- El 403 por atribución se evalúa **antes** de la comprobación de idempotencia: reenviar con otros headers es 403, no 200.
- Cuando el total es `0` (producto con precio 0) y `cashReceivedMinor` es `0`, la venta es válida.

**Ejemplo de request** (fixtures de `src/docs/bazaar-examples.ts`, coherentes con `test/sales-conflict.e2e-spec.ts`)

```json
{
  "id": "40000000-0000-4000-8000-000000000001",
  "memberId": "10000000-0000-4000-8000-000000000003",
  "deviceId": "20000000-0000-4000-8000-000000000001",
  "occurredAt": "2026-09-23T12:00:00.000Z",
  "currency": "MXN",
  "cashReceivedMinor": 250000,
  "items": [
    { "productId": "30000000-0000-4000-8000-000000000001", "quantity": 1, "unitPriceMinor": 125000 },
    { "productId": "30000000-0000-4000-8000-000000000002", "quantity": 1, "unitPriceMinor": 85000 }
  ]
}
```

**Respuesta 201 (completada)**

```json
{
  "id": "40000000-0000-4000-8000-000000000001",
  "memberId": "10000000-0000-4000-8000-000000000003",
  "deviceId": "20000000-0000-4000-8000-000000000001",
  "contextId": "bazar-local",
  "occurredAt": "2026-09-23T12:00:00.000Z",
  "receivedAt": "2026-09-23T12:00:01.000Z",
  "currency": "MXN",
  "status": "completada",
  "totalMinor": 210000,
  "cashReceivedMinor": 250000,
  "requestFingerprint": "3f5c...",
  "changeMinor": 40000,
  "conflictReason": null,
  "conflictDetectedAt": null,
  "items": [
    { "id": "41000000-0000-4000-8000-000000000001", "productId": "30000000-0000-4000-8000-000000000001", "quantity": 1, "unitPriceMinor": 125000, "subtotalMinor": 125000, "createdAt": "2026-09-23T12:00:01.000Z" },
    { "id": "41000000-0000-4000-8000-000000000002", "productId": "30000000-0000-4000-8000-000000000002", "quantity": 1, "unitPriceMinor": 85000, "subtotalMinor": 85000, "createdAt": "2026-09-23T12:00:01.000Z" }
  ]
}
```

**Respuesta 201 con conflicto en el cuerpo** (mismo código HTTP; el cliente debe leer `status`)

```json
{
  "id": "40000000-0000-4000-8000-000000000002",
  "memberId": "10000000-0000-4000-8000-000000000003",
  "deviceId": "20000000-0000-4000-8000-000000000001",
  "contextId": "bazar-local",
  "occurredAt": "2026-09-23T12:00:00.000Z",
  "receivedAt": "2026-09-23T12:00:02.000Z",
  "currency": "MXN",
  "status": "rechazada_por_conflicto",
  "totalMinor": null,
  "cashReceivedMinor": 125000,
  "requestFingerprint": "9a1e...",
  "changeMinor": null,
  "conflictReason": "stock insuficiente al sincronizar: producto 30000000-0000-4000-8000-000000000001, solicitado 1, disponible 0",
  "conflictDetectedAt": "2026-09-23T12:00:02.000Z",
  "items": []
}
```

Fuente: `src/sales/sales.controller.ts:50-65`, `src/sales/dto/create-sale.dto.ts:23-86`, `src/sales/dto/sale-payment.dto.ts:5-10`, `src/sales/sales.service.ts:67-80,91-102,279-507`, `test/sales.e2e-spec.ts:124-435`, `test/sales-conflict.e2e-spec.ts:118-260`.

<a id="ep-sales-list"></a>
### `GET /api/v1/sales`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) ("movimientos") |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, `{ items, total, page, limit }` con ventas (forma de la tabla anterior) |

**Query** (desconocidos = 400):

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `status` | `completada` \| `rechazada_por_conflicto` | sin filtro | `rechazada_por_conflicto` = cola de revisión manual |
| `search` | string 0..200 | sin filtro | coincidencia parcial sin distinguir mayúsculas sobre el **nombre del vendedor** (Member), no sobre el `id` de la venta |
| `sort` | `asc` \| `desc` | `desc` | ordena por `receivedAt` |
| `page` | integer 1..1000000 | 1 | |
| `limit` | integer 1..100 | 20 | |

**Errores**: 400 (query inválida), 401, 403 (selección o no es socio; un colaborador recibe `"Only socios may access this resource"`).

**Ejemplo**

```http
GET /api/v1/sales?status=rechazada_por_conflicto&sort=desc&page=1&limit=20 HTTP/1.1
```

```json
{ "items": [ { "id": "40000000-0000-4000-8000-000000000002", "status": "rechazada_por_conflicto", "totalMinor": null, "items": [], "...": "resto de campos como en POST /sales" } ], "total": 1, "page": 1, "limit": 20 }
```

Fuente: `src/sales/sales.controller.ts:67-75`, `src/sales/dto/sale-list.dto.ts:17-50`, `src/sales/sales.service.ts:545-574`, `test/sales-conflict.e2e-spec.ts:239-305`.

<a id="ep-sales-get"></a>
### `GET /api/v1/sales/:id`

| | |
|---|---|
| Audiencia | Cuenta autenticada; cualquier Member (solo `AuthGuard`; **no** requiere `x-member-id`/`x-device-id` y **no** se limita al vendedor) |
| Headers | `Authorization` |
| Éxito | **200**, una venta (completada o rechazada por conflicto) |

Sirve para confirmar el resultado tras una respuesta perdida. Una venta rechazada por conflicto también se devuelve con 200; distingue por `status`.

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 401 | sin token | `"Unauthorized"` |
| 404 | No existe o es de otro negocio (indistinguibles) | `"Not Found"` |

Ejemplo de respuesta: igual que la de `POST /api/v1/sales`.

Fuente: `src/sales/sales.controller.ts:77-85`, `src/sales/sales.service.ts:521-528`, `test/sales.e2e-spec.ts:385-435`.

---

<a id="mod-incidencias"></a>
## 7. Incidencias

Registro de cosas que un socio debe revisar después de una venta: un conflicto de stock (`conflicto_stock`, nace con una venta `rechazada_por_conflicto`) o una fecha `occurredAt` fuera de rango (`incidencia_fecha`: futura, o más de 2 días anterior a la recepción; la venta sí se cobró). Reglas:

- **Todo el módulo es solo para socios** (`SocioGuard` a nivel de controlador): un colaborador no las ve ni las resuelve (403).
- Estado: `pendiente` hasta que un socio la marca `resuelta` con notas de lo acordado. **No existe "des-resolver"** y resolver dos veces da 409. No hay resolución automática: resolver una incidencia **solo actualiza el registro** de la incidencia; no reembolsa, no repone stock ni modifica la venta.
- El resolutor es siempre el socio elegido (`x-member-id`); no se envía en el body.
- Una venta puede tener más de una incidencia (p. ej. conflicto de stock y fecha).

Forma de una incidencia (registro crudo):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | |
| `saleId` | string | |
| `contextId` | string | ignorable |
| `type` | `"conflicto_stock"` \| `"incidencia_fecha"` | |
| `reason` | string | texto explicativo generado por el servidor |
| `detectedAt` | string (ISO 8601) | |
| `resolutionStatus` | `"pendiente"` \| `"resuelta"` | |
| `resolvedByMemberId` | string \| null | |
| `resolvedAt` | string \| null | |
| `resolutionNotes` | string \| null | |

<a id="ep-incidencias-list"></a>
### `GET /api/v1/incidencias`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, `{ items, total, page, limit }`; los `items` **no** incluyen la venta |

**Query** (desconocidos = 400): `type` (`conflicto_stock` \| `incidencia_fecha`), `resolutionStatus` (`pendiente` \| `resuelta`; sin filtro por defecto, es decir lista todas), `search` (0..200, nombre del **vendedor** de la venta relacionada, no del resolutor), `sort` (`asc`/`desc`, def. `desc`, por `detectedAt`), `page` (def. 1), `limit` (def. 20, máx. 100).

**Errores**: 400, 401, 403.

**Ejemplo**

```http
GET /api/v1/incidencias?resolutionStatus=pendiente&type=conflicto_stock HTTP/1.1
```

```json
{
  "items": [
    {
      "id": "50000000-0000-4000-8000-000000000001",
      "saleId": "40000000-0000-4000-8000-000000000002",
      "contextId": "bazar-local",
      "type": "conflicto_stock",
      "reason": "stock insuficiente al sincronizar: producto 30000000-0000-4000-8000-000000000001, solicitado 1, disponible 0",
      "detectedAt": "2026-09-23T12:00:02.000Z",
      "resolutionStatus": "pendiente",
      "resolvedByMemberId": null,
      "resolvedAt": null,
      "resolutionNotes": null
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

Fuente: `src/incidencias/incidencias.controller.ts:41,48-55`, `src/incidencias/dto/incidencia.dto.ts:13-51`, `src/incidencias/incidencias.service.ts:40-78`, `test/incidencias.e2e-spec.ts:205-234`.

<a id="ep-incidencias-get"></a>
### `GET /api/v1/incidencias/:id`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, la incidencia **más** su venta en `sale` (con `items`) |

La venta anidada es el registro crudo de Prisma: incluye `contextId`, `requestFingerprint`, y cada elemento de `sale.items` es el registro crudo de `SaleItem` (trae además `saleId` y `contextId`, a diferencia de la venta devuelta por `/sales`).

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | Incidencia inexistente o de otro negocio | `"Not Found"` |

Ejemplo de respuesta: el objeto incidencia de arriba más `"sale": { ...venta rechazada, "items": [] }`.

Fuente: `src/incidencias/incidencias.controller.ts:57-64`, `src/incidencias/incidencias.service.ts:89-96`.

<a id="ep-incidencias-resolver"></a>
### `PATCH /api/v1/incidencias/:id/resolver`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio; queda como `resolvedByMemberId`), `x-device-id` |
| Éxito | **200**, la incidencia ya resuelta (sin `sale` anidada) |

La ruta se llama **`/resolver`** (español), no `/resolve`.

**Body**:

| Campo | Tipo | Reglas |
|---|---|---|
| `resolutionNotes` | string | requerido, 1..2000. Documenta qué se acordó con el cliente |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 400 | Falta `resolutionNotes`, vacío, > 2000 caracteres o campo desconocido (p. ej. `resolvedByMemberId`) | array de validación |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | Incidencia inexistente o de otro negocio | `"Not Found"` |
| 409 | Ya estaba resuelta (no se sobrescribe) | `"Incidencia <id> is already resolved"` |

**Ejemplo** (fixtures de `bazaar-examples.ts`)

```json
{ "resolutionNotes": "Adid contacted the customer; the unavailable Spider-Man 2 copy will not be charged. No automatic inventory change." }
```

```json
{
  "id": "50000000-0000-4000-8000-000000000001",
  "saleId": "40000000-0000-4000-8000-000000000002",
  "contextId": "bazar-local",
  "type": "conflicto_stock",
  "reason": "stock insuficiente al sincronizar: producto 30000000-0000-4000-8000-000000000001, solicitado 1, disponible 0",
  "detectedAt": "2026-09-23T12:00:02.000Z",
  "resolutionStatus": "resuelta",
  "resolvedByMemberId": "bf030001-0000-4000-8000-000000000002",
  "resolvedAt": "2026-09-23T14:00:00.000Z",
  "resolutionNotes": "Adid contacted the customer; the unavailable Spider-Man 2 copy will not be charged. No automatic inventory change."
}
```

Fuente: `src/incidencias/incidencias.controller.ts:66-82`, `src/incidencias/dto/incidencia.dto.ts:53-61`, `src/incidencias/incidencias.service.ts:117-142`, `test/incidencias.e2e-spec.ts:178-204`.

---

<a id="mod-commissions"></a>
## 8. Commissions (incluye `PATCH /settings/commission-rate`)

Cálculo (nunca pago) de la comisión de los **colaboradores**. Reglas:

- La comisión es un **porcentaje** de lo que el colaborador vendió en el periodo (no un monto fijo por venta).
- Tasa efectiva = tasa individual del colaborador (`commissionRateBps`, si no es `null`) o, si no, la **tasa global por defecto** del negocio. La global es `0` hasta que un socio la configure (no se deben comisiones por defecto).
- Ambas tasas son enteros en puntos base (`1000` = 10.00 %), rango 0..10000.
- Solo suman ventas `completada`, ancladas a `receivedAt` (reloj del servidor). Una venta con incidencia pendiente **sí** cuenta.
- Periodo: si no se envían `from`/`to`, se usa la **semana actual domingo–sábado** en hora de negocio (UTC-6). Si se envían, deben enviarse **los dos**.
- Redondeo a centavos *half-up* a favor del colaborador.
- Solo los socios configuran tasas y consultan comisiones.

<a id="ep-commissions-get"></a>
### `GET /api/v1/commissions`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, `{ from, to, items }` (no paginado) |

**Query** (desconocidos = 400):

| Param | Tipo | Reglas |
|---|---|---|
| `from` | string | opcional; fecha `YYYY-MM-DD` (inicio del día local) o instante ISO 8601. Va **junto con `to`** o ninguno |
| `to` | string | opcional; fecha `YYYY-MM-DD` (fin del día local, inclusive) o instante ISO 8601 |
| `memberId` | string (UUID) | opcional; restringe a un colaborador. Sin él se listan todos los colaboradores del negocio (**incluidos los desactivados**; los socios nunca aparecen) |

**Respuesta 200**:

| Campo | Tipo | Notas |
|---|---|---|
| `from`, `to` | string (ISO 8601 UTC) | límites efectivos e inclusivos del periodo |
| `items[]` | array | ordenado por nombre; uno por colaborador |
| `items[].memberId` | string | |
| `items[].memberName` | string | |
| `items[].totalSoldMinor` | integer | suma de `totalMinor` de sus ventas completadas del periodo (0 si no vendió) |
| `items[].rateBps` | integer | tasa efectiva usada |
| `items[].commissionMinor` | integer | `totalSoldMinor × rateBps / 10000`, redondeado *half-up* a centavos |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Solo uno de `from`/`to` | `"from and to must be provided together, or omitted together for the current week"` |
| 400 | Fecha no ISO 8601, `memberId` no UUID, parámetro desconocido | array de validación |
| 400 | Formato que `IsISO8601` acepta pero `Date` no puede leer (semana `2026-W38`, ordinal `2026-263`) | **string**, no array: `"Invalid date: 2026-W38"` (verificado en vivo) |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | `memberId` no corresponde a un colaborador de este negocio (inexistente, de otro negocio o un socio) | `"Colaborador <id> not found in this context"` |

Notas: el código no valida que `from` <= `to`. Verificado en vivo: con `from` posterior a `to` responde **200** con los totales en cero y `from`/`to` devueltos tal cual, sin error.

**Ejemplo** (fixtures: semana domingo 2026-09-20 a sábado 2026-09-26)

```http
GET /api/v1/commissions?from=2026-09-20&to=2026-09-26 HTTP/1.1
```

```json
{
  "from": "2026-09-20T06:00:00.000Z",
  "to": "2026-09-27T05:59:59.999Z",
  "items": [
    { "memberId": "10000000-0000-4000-8000-000000000003", "memberName": "Carlos", "totalSoldMinor": 210000, "rateBps": 1000, "commissionMinor": 21000 },
    { "memberId": "10000000-0000-4000-8000-000000000004", "memberName": "Javier", "totalSoldMinor": 0, "rateBps": 1500, "commissionMinor": 0 }
  ]
}
```

Fuente: `src/commissions/commissions.controller.ts:33-46`, `src/commissions/dto/commission.dto.ts:46-73`, `src/commissions/commissions.service.ts:124-179`, `src/common/business-time.ts:45-100`, `test/commissions.e2e-spec.ts:171-314`.

<a id="ep-settings-commission-rate"></a>
### `PATCH /api/v1/settings/commission-rate`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, la configuración del negocio (registro `AppSettings`) |

Fija la tasa global por defecto (para colaboradores sin tasa individual). Es un *upsert* idempotente.

**Body**:

| Campo | Tipo | Reglas |
|---|---|---|
| `rateBps` | integer | requerido; 0..10000 (puntos base; `1000` = 10.00 %). Decimales o fuera de rango = 400 |

**Respuesta 200**: `{ contextId: string, defaultCommissionRateBps: integer, updatedAt: string (ISO 8601) }`.

**Errores**: 400 (falta `rateBps`, decimal, negativo, > 10000, campo desconocido), 401/403 (ver [1.3](#f-auth)).

**Ejemplo**

```json
{ "rateBps": 1000 }
```

```json
{ "contextId": "bazar-local", "defaultCommissionRateBps": 1000, "updatedAt": "2026-09-23T12:00:00.000Z" }
```

Fuente: `src/commissions/settings.controller.ts:37-51`, `src/commissions/dto/commission.dto.ts:16-27`, `src/commissions/commissions.service.ts:57-63`, `prisma/schema.prisma` (modelo `AppSettings`).

<a id="ep-members-commission-rate"></a>
### `PATCH /api/v1/members/:id/commission-rate`

(Ruta del controlador de Members; se documenta aquí por su tema.)

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, el Member completo actualizado (forma en [Members](#mod-members)) |

Fija o borra la tasa individual de un **colaborador**. Equivalente a enviar `commissionRateBps` en `PATCH /members/:id`, pero con otro nombre de campo (`rateBps`) y otros mensajes.

**Body**:

| Campo | Tipo | Reglas |
|---|---|---|
| `rateBps` | integer \| null | **requerido** (omitirlo es 400); 0..10000; `null` borra el override y vuelve a la tasa global |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 400 | `rateBps` ausente, decimal, fuera de rango o campo desconocido | array de validación |
| 400 | El Member destino es socio | `"Only colaboradores have an individual commission rate"` |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | El Member no existe en este negocio | `"Member <id> not found"` |

**Ejemplo** (fixtures)

```json
{ "rateBps": 1000 }
```

```json
{
  "id": "10000000-0000-4000-8000-000000000003",
  "name": "Carlos",
  "role": "colaborador",
  "contextId": "bazar-local",
  "createdAt": "2026-09-23T12:00:00.000Z",
  "active": true,
  "commissionRateBps": 1000
}
```

Fuente: `src/members/members.controller.ts:73-86`, `src/commissions/dto/commission.dto.ts:29-44`, `src/commissions/commissions.service.ts:79-96`.

---

<a id="mod-reports"></a>
## 9. Reports

Dos reportes de solo lectura, solo para socios. Reglas:

- **`from` y `to` son obligatorios** (a diferencia de `/commissions`, no hay periodo por defecto).
- Solo cuentan ventas `completada` (una `rechazada_por_conflicto` nunca genera ingreso). Los abonos de deudas **no** son ventas y no aparecen.
- El periodo se ancla a `receivedAt` (reloj del servidor), con límites inclusivos. Fecha simple `YYYY-MM-DD`: `from` = inicio de ese día local, `to` = fin de ese día local (hora de negocio fija UTC-6). Instante ISO 8601 completo: se usa tal cual. La respuesta devuelve los límites ya normalizados en UTC.
- No hay paginación.

<a id="ep-reports-period"></a>
### `GET /api/v1/reports/sales-by-period`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200** |

**Query** (ambos requeridos; desconocidos = 400): `from`, `to` (fecha `YYYY-MM-DD` o ISO 8601).

**Respuesta 200**: `{ from: string, to: string, totalSoldMinor: integer, saleCount: integer }` (`totalSoldMinor` es la suma de `totalMinor` de las ventas completadas del periodo, de cualquier vendedor; `0` si no hubo).

**Errores**: 400 (falta `from` o `to`, valor que no es una fecha ISO 8601, parámetro desconocido; mensaje del tipo `"from must be a valid ISO 8601 date string"`), 401, 403. No se valida `from` <= `to`: con el orden invertido responde **200** con `totalSoldMinor: 0` y `saleCount: 0` (verificado en vivo). Los formatos ISO 8601 raros (semana u ordinal) responden 400 con el `message` como **string** `"Invalid date: <valor>"`, no como array.

**Ejemplo**

```http
GET /api/v1/reports/sales-by-period?from=2026-09-20&to=2026-09-26 HTTP/1.1
```

```json
{ "from": "2026-09-20T06:00:00.000Z", "to": "2026-09-27T05:59:59.999Z", "totalSoldMinor": 210000, "saleCount": 1 }
```

Fuente: `src/reports/reports.controller.ts:33,39-46`, `src/reports/dto/date-range.dto.ts:8-22`, `src/reports/reports.service.ts:19-55`, `src/common/business-time.ts:84-100`, `test/reports.e2e-spec.ts:167-215`.

<a id="ep-reports-member"></a>
### `GET /api/v1/reports/sales-by-member`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200** |

Mismo query que el anterior (`from`, `to` requeridos).

**Respuesta 200**: `{ from, to, items }` donde cada elemento es `{ memberId: string, memberName: string | null, role: "socio" | "colaborador" | null, totalSoldMinor: integer }`. Incluye socios y colaboradores (un socio también vende); los Members **sin ventas completadas en el periodo no aparecen**. Orden: `totalSoldMinor` descendente. (`memberName`/`role` pueden ser `null` solo si el Member ya no se pudiera resolver; en la práctica siempre vienen.)

**Errores**: iguales a `sales-by-period`.

**Ejemplo**

```json
{
  "from": "2026-09-20T06:00:00.000Z",
  "to": "2026-09-27T05:59:59.999Z",
  "items": [
    { "memberId": "10000000-0000-4000-8000-000000000003", "memberName": "Carlos", "role": "colaborador", "totalSoldMinor": 210000 }
  ]
}
```

Fuente: `src/reports/reports.controller.ts:48-55`, `src/reports/reports.service.ts:65-90`, `test/reports.e2e-spec.ts:216-238`.

---

<a id="mod-deudas"></a>
## 10. Deudas

Un solo concepto **Deuda** con dos tipos: `fiado` (el producto ya se entregó) y `apartado` (el producto se reserva). Reglas:

- **Solo un socio puede crear una deuda** (autorizar crédito/apartado) y solo los socios listan/consultan deudas. **Cualquier Member activo** (también un colaborador) puede **registrar un abono** (`ContextGuard`).
- Es de **un solo producto y cantidad** por deuda (no un carrito). Para varios productos hay que crear varias deudas.
- Ambos tipos **descuentan stock de inmediato** al crearse (para no venderlo a otro mientras se paga). Stock insuficiente = 400 simple (no hay "conflicto" persistido).
- El total (`totalMinor`) es `precio actual del producto × cantidad`, calculado por el servidor; el cliente no manda precio. No se puede usar un producto desactivado.
- El deudor es un registro informal (nombre, teléfono y notas opcionales, sin identidad formal). Se envía **exactamente uno** de `deudorId` (deudor existente) o `deudor` (datos para crear uno nuevo en la misma transacción); ninguno o los dos es 400.
- Un abono **no puede exceder el saldo pendiente**; no hay aplicación parcial. Cuando la suma de abonos iguala el total, `status` pasa solo a `saldada`; **no existe endpoint para cambiar el estado** manualmente.
- La respuesta **no trae un campo de saldo**: se calcula en el cliente como `totalMinor - suma(abonos[].montoMinor)`.
- No existe endpoint para editar ni cancelar una deuda, ni para devolver el stock.

Forma de una deuda (registro crudo; `deudor` y `abonos` según el endpoint):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string (UUIDv7) | |
| `type` | `"fiado"` \| `"apartado"` | |
| `deudorId` | string | |
| `productId` | string | |
| `contextId` | string | ignorable |
| `cantidad` | integer | |
| `totalMinor` | integer | total original, no baja con los abonos |
| `status` | `"pendiente"` \| `"saldada"` | derivado |
| `createdByMemberId` | string | socio que la creó |
| `createdAt` | string (ISO 8601) | |
| `abonos` | array | cada uno `{ id, deudaId, contextId, montoMinor, receivedByMemberId, receivedAt, nota }` |
| `deudor` | objeto | `{ id, nombre, telefono, notas, contextId, createdAt }`. **No** viene en la respuesta de `POST /deudas`; sí en el listado, el detalle y el abono |

<a id="ep-deudas-create"></a>
### `POST /api/v1/deudas`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **201**, la deuda con `abonos: []` (**sin** `deudor` anidado) |

**Body** (desconocidos, también dentro de `deudor`, = 400):

| Campo | Tipo | Reglas |
|---|---|---|
| `type` | `"fiado"` \| `"apartado"` | requerido |
| `productId` | string (UUID) | requerido |
| `cantidad` | integer | requerido; 1..100000 |
| `deudorId` | string (UUID) | opcional; deudor existente del negocio. Excluyente con `deudor` |
| `deudor` | objeto | opcional; crea un deudor nuevo. Excluyente con `deudorId` |
| `deudor.nombre` | string | requerido dentro de `deudor`; 1..200 |
| `deudor.telefono` | string | opcional; 1..50 |
| `deudor.notas` | string | opcional; 0..2000 |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Validación (tipo fuera del enum, `cantidad` < 1 o decimal, UUID inválido, `deudor.nombre` faltante, campo desconocido) | array de validación |
| 400 | Se envían los dos o ninguno de `deudorId`/`deudor` | `"Exactly one of deudorId or deudor must be provided"` |
| 400 | `deudorId` no existe en el negocio | `"Deudor <id> does not exist in this context"` |
| 400 | `productId` no existe en el negocio | `"Product <id> does not exist in this context"` |
| 400 | Producto desactivado | `"Product <id> is deactivated and cannot be used for a new deuda"` |
| 400 | `cantidad` mayor al stock | `"Insufficient stock for product <id>"` |
| 401 / 403 | ver [1.3](#f-auth) (un colaborador recibe 403) | |

Todo ocurre en una transacción: si falla algo, no se crea el deudor inline ni se descuenta stock.

**Ejemplo** (fixtures)

```json
{
  "type": "apartado",
  "productId": "30000000-0000-4000-8000-000000000003",
  "cantidad": 1,
  "deudor": { "nombre": "Lucía (example customer)", "telefono": "EXAMPLE-PHONE", "notas": "Collect Gran Turismo 7 on Saturday." }
}
```

```json
{
  "id": "70000000-0000-4000-8000-000000000001",
  "type": "apartado",
  "deudorId": "60000000-0000-4000-8000-000000000001",
  "productId": "30000000-0000-4000-8000-000000000003",
  "contextId": "bazar-local",
  "cantidad": 1,
  "totalMinor": 65000,
  "status": "pendiente",
  "createdByMemberId": "bf030001-0000-4000-8000-000000000001",
  "createdAt": "2026-09-23T12:00:00.000Z",
  "abonos": []
}
```

Fuente: `src/deudas/deudas.controller.ts:46-54`, `src/deudas/dto/create-deuda.dto.ts:22-70`, `src/deudas/deudas.service.ts:114-195`, `test/deudas.e2e-spec.ts:135-240`, `test/soft-delete.e2e-spec.ts:256-282`.

<a id="ep-deudas-list"></a>
### `GET /api/v1/deudas`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, `{ items, total, page, limit }`; cada deuda incluye `abonos` y `deudor` |

**Query** (desconocidos = 400): `status` (`pendiente` \| `saldada`; sin filtro por defecto; el uso típico es `pendiente` = "quién debe"), `search` (0..200, coincidencia parcial sin distinguir mayúsculas sobre el **nombre del deudor**), `sort` (`asc`/`desc`, def. `desc`, por `createdAt`), `page` (def. 1), `limit` (def. 20, máx. 100).

**Errores**: 400, 401, 403.

**Ejemplo**

```http
GET /api/v1/deudas?status=pendiente&search=Luc HTTP/1.1
```

```json
{
  "items": [
    {
      "id": "70000000-0000-4000-8000-000000000001",
      "type": "apartado",
      "deudorId": "60000000-0000-4000-8000-000000000001",
      "productId": "30000000-0000-4000-8000-000000000003",
      "contextId": "bazar-local",
      "cantidad": 1,
      "totalMinor": 65000,
      "status": "pendiente",
      "createdByMemberId": "bf030001-0000-4000-8000-000000000001",
      "createdAt": "2026-09-23T12:00:00.000Z",
      "abonos": [],
      "deudor": {
        "id": "60000000-0000-4000-8000-000000000001",
        "nombre": "Lucía (example customer)",
        "telefono": "EXAMPLE-PHONE",
        "notas": "Collect Gran Turismo 7 on Saturday.",
        "contextId": "bazar-local",
        "createdAt": "2026-09-23T12:00:00.000Z"
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

Fuente: `src/deudas/deudas.controller.ts:56-64`, `src/deudas/dto/deuda-list.dto.ts:13-44`, `src/deudas/deudas.service.ts:204-238`.

<a id="ep-deudas-get"></a>
### `GET /api/v1/deudas/:id`

| | |
|---|---|
| Audiencia | Solo socios (`SocioGuard`) |
| Headers | `Authorization`, `x-member-id` (un socio), `x-device-id` |
| Éxito | **200**, una deuda con `abonos` (historial completo) y `deudor` |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 401 / 403 | ver [1.3](#f-auth) | |
| 404 | Deuda inexistente o de otro negocio | `"Not Found"` |

Ejemplo de respuesta: un elemento de `items` del listado anterior (con los `abonos` que tenga).

Fuente: `src/deudas/deudas.controller.ts:66-74`, `src/deudas/deudas.service.ts:248-255`.

<a id="ep-deudas-abonos"></a>
### `POST /api/v1/deudas/:id/abonos`

| | |
|---|---|
| Audiencia | Cualquier Member activo con dispositivo autorizado (`ContextGuard`); **no** exige ser socio |
| Headers | `Authorization`, `x-member-id`, `x-device-id` |
| Éxito | **201**, la **deuda actualizada** (con `abonos` y `deudor`), no el abono suelto |

Registra un pago contra la deuda. Quien recibe el abono queda como `receivedByMemberId` (el Member de `x-member-id`). Los abonos concurrentes se serializan. Si el abono cubre exactamente el saldo, `status` queda en `saldada` en la misma transacción.

**Body**:

| Campo | Tipo | Reglas |
|---|---|---|
| `montoMinor` | integer | requerido; 1..2147483647 (centavos) |
| `nota` | string | opcional; 0..2000 |

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | `:id` no UUID | `"Validation failed (uuid is expected)"` |
| 400 | `montoMinor` ausente, < 1, decimal, campo desconocido, `nota` > 2000 | array de validación |
| 400 | El monto excede el saldo pendiente (incluye abonar a una deuda ya `saldada`, cuyo saldo es 0) | `"Abono of <monto> exceeds the remaining balance of <saldo>"` |
| 401 | sin token | `"Unauthorized"` |
| 403 | Headers de selección ausentes/no autorizados | ver [1.3](#f-auth) |
| 404 | Deuda inexistente o de otro negocio | `"Not Found"` |

**Ejemplo** (fixtures: abono de $200.00 sobre una deuda de $650.00 deja un saldo de $450.00)

```json
{ "montoMinor": 20000, "nota": "First cash payment collected by Javier." }
```

```json
{
  "id": "70000000-0000-4000-8000-000000000001",
  "type": "apartado",
  "deudorId": "60000000-0000-4000-8000-000000000001",
  "productId": "30000000-0000-4000-8000-000000000003",
  "contextId": "bazar-local",
  "cantidad": 1,
  "totalMinor": 65000,
  "status": "pendiente",
  "createdByMemberId": "bf030001-0000-4000-8000-000000000001",
  "createdAt": "2026-09-23T12:00:00.000Z",
  "abonos": [
    {
      "id": "80000000-0000-4000-8000-000000000001",
      "deudaId": "70000000-0000-4000-8000-000000000001",
      "contextId": "bazar-local",
      "montoMinor": 20000,
      "receivedByMemberId": "10000000-0000-4000-8000-000000000004",
      "receivedAt": "2026-09-23T13:00:00.000Z",
      "nota": "First cash payment collected by Javier."
    }
  ],
  "deudor": {
    "id": "60000000-0000-4000-8000-000000000001",
    "nombre": "Lucía (example customer)",
    "telefono": "EXAMPLE-PHONE",
    "notas": "Collect Gran Turismo 7 on Saturday.",
    "contextId": "bazar-local",
    "createdAt": "2026-09-23T12:00:00.000Z"
  }
}
```

Fuente: `src/deudas/deudas.controller.ts:76-85`, `src/deudas/dto/create-abono.dto.ts:5-13`, `src/deudas/deudas.service.ts:281-356`, `test/deudas.e2e-spec.ts:241-330`.

---

<a id="mod-business-registration"></a>
## 11. Business Registration

Alta pública de un negocio nuevo, con aprobación manual por correo. Es un flujo **especial**: enteramente público (sin `Authorization` ni headers de selección) y limitado a este alcance. Reglas:

1. Alguien envía el formulario (`POST /business-registration`). Se crea una solicitud `pendiente` y se envía un correo (vía Resend) al aprobador fijo del sistema (`APPROVAL_NOTIFICATION_EMAIL`) con dos enlaces: aprobar y rechazar.
2. El aprobador abre uno de los enlaces (`GET .../approve?token=...` o `GET .../reject?token=...`) **desde su cliente de correo**. Ambos endpoints devuelven una **página HTML**, no JSON: no están pensados para llamarse desde el frontend con Axios. Los enlaces apuntan al origen de la API (`APP_BASE_URL` + `/api/v1/business-registration/...`), no al frontend.
3. El token es de un solo uso y expira a los **30 días**; solo se guarda su hash. Nunca se devuelve por la API.
4. Al **aprobar** se crea el `contextId` real del negocio y un Member fundador con `role: "socio"` (activo). Al **rechazar** no se crea nada operativo.
5. **Importante**: la aprobación crea únicamente el Member fundador. **No crea ninguna cuenta (Account) ni dispositivo (Device)**, y no existe endpoint para crearlos; sin ellos el negocio nuevo todavía no puede hacer login ni operar (la página de aprobación dice "listo para iniciar sesión", pero según el código hacen falta cuenta y dispositivo creados fuera de banda).
6. **No existe `GET /business-registration`** ni ningún endpoint para consultar el estado de una solicitud: el frontend no puede saber si fue aprobada. Las únicas rutas de este módulo son `POST /business-registration`, `GET /business-registration/approve` y `GET /business-registration/reject`.

<a id="ep-br-create"></a>
### `POST /api/v1/business-registration`

| | |
|---|---|
| Audiencia | Pública, flujo de registro de negocio (sin token, sin headers de selección) |
| Headers | `Content-Type: application/json` |
| Éxito | **201** |

**Body** (desconocidos = 400):

| Campo | Tipo | Reglas |
|---|---|---|
| `nombreNegocio` | string | requerido; 1..200; con algún carácter no blanco |
| `nombreSocio` | string | requerido; 1..200; con algún carácter no blanco (nombre del socio fundador) |
| `contactoSocio` | string | requerido; 1..200; con algún carácter no blanco. Texto libre (correo o teléfono), sin validar formato |

**Respuesta 201**: `{ "id": string, "status": "pendiente", "createdAt": string (ISO 8601) }` (solo esos tres campos).

**Errores**

| HTTP | Situación | `message` |
|---|---|---|
| 400 | Falta un campo, está en blanco, supera 200 caracteres o hay un campo desconocido | array de validación |
| 500 | El correo de aprobación no pudo enviarse (falta `RESEND_API_KEY` o `APPROVAL_NOTIFICATION_EMAIL`, o Resend rechazó el envío). **La solicitud ya se creó** como `pendiente`, pero nadie tiene su enlace | `"Internal server error"` |

Notas: no hay limitación de tasa (*rate limiting*) en el código; cada llamada válida crea una solicitud y dispara un correo.

**Ejemplo** (`test/business-registration.e2e-spec.ts:234-250`)

```json
{ "nombreNegocio": "Bonsáis del Alberto", "nombreSocio": "Alberto", "contactoSocio": "alberto@example.test" }
```

```json
{ "id": "a0000000-0000-4000-8000-000000000001", "status": "pendiente", "createdAt": "2026-09-23T12:00:00.000Z" }
```

Fuente: `src/business-registration/business-registration.controller.ts:39-53`, `src/business-registration/dto/create-business-registration.dto.ts:16-23`, `src/business-registration/business-registration.service.ts:83-114`, `src/email/email.service.ts:48-73`, `doc/reglas-de-negocio.md:131`.

<a id="ep-br-approve"></a>
### `GET /api/v1/business-registration/approve`

| | |
|---|---|
| Audiencia | Pública, flujo de registro de negocio (enlace del correo; sin token JWT) |
| Headers | ninguno |
| Éxito | **200** con `Content-Type: text/html` |

**Query**: `token` (string; el token en claro del enlace del correo). No pasa por `ValidationPipe`.

Respuestas (siempre una página HTML, nunca JSON):

| HTTP | Situación | Título de la página (`<h1>`) |
|---|---|---|
| 200 | Token válido, pendiente y sin expirar: crea `contextId` y Member socio fundador, solicitud pasa a `aprobado` | `Negocio aprobado` |
| 200 | La solicitud ya fue resuelta antes (aprobada o rechazada); no se duplica nada | `Ya fue procesado` |
| 200 | El token expiró (más de 30 días desde la solicitud) | `El enlace expiró` |
| 404 | Falta el parámetro `token` | `Enlace inválido` (`Falta el parámetro token en el enlace.`) |
| 404 | El token no corresponde a ninguna solicitud | `Enlace inválido` (`Este enlace no corresponde a ninguna solicitud.`) |

Un token ya usado o expirado **no** da error HTTP: es 200 con la página correspondiente.

**Ejemplo**

```http
GET /api/v1/business-registration/approve?token=example-raw-token-from-the-emailed-link HTTP/1.1
```

```html
<!doctype html>
<html lang="es">
  <head><meta charset="utf-8" /><title>Negocio aprobado</title></head>
  <body ...><h1>Negocio aprobado</h1><p>"Bonsáis del Alberto" ya está activo y listo para iniciar sesión.</p></body>
</html>
```

Fuente: `src/business-registration/business-registration.controller.ts:55-66`, `src/business-registration/business-registration.service.ts:122-148,176-221`, `src/business-registration/status-page.html.ts:9-21`, `test/business-registration.e2e-spec.ts:252-282,307-369`.

<a id="ep-br-reject"></a>
### `GET /api/v1/business-registration/reject`

| | |
|---|---|
| Audiencia | Pública, flujo de registro de negocio (enlace del correo; sin token JWT) |
| Headers | ninguno |
| Éxito | **200** con `Content-Type: text/html` |

Mismo `token` y mismas respuestas HTML que `approve`, salvo que el caso exitoso marca la solicitud como `rechazado` y **no crea nada** (ni `contextId` ni Member). Título en éxito: `Solicitud rechazada`.

Ejemplo de página de éxito: `<h1>Solicitud rechazada</h1><p>La solicitud de "Bonsáis del Alberto" fue rechazada. No se creó nada.</p>`.

Fuente: `src/business-registration/business-registration.controller.ts:68-77`, `src/business-registration/business-registration.service.ts:154-165`, `test/business-registration.e2e-spec.ts:284-305`.

---

<a id="apendice-a-indice-de-rutas"></a>
## Apéndice A: índice de rutas

33 rutas de negocio, todas bajo el prefijo `/api/v1`. "Audiencia": **Pública** = sin token; **Cuenta** = solo `Authorization` (`AuthGuard`); **Member** = `Authorization` + `x-member-id` + `x-device-id` con cualquier Member activo (`ContextGuard`); **Socio** = lo mismo con un Member `socio` (`SocioGuard`); **Registro de negocio** = pública, limitada a ese flujo.

| Método | Ruta | Audiencia | Sección |
|---|---|---|---|
| `GET` | `/api/v1` | Pública | [Hello World](#f-montajes) |
| `POST` | `/api/v1/auth/login` | Pública | [Auth](#ep-auth-login) |
| `GET` | `/api/v1/members` | Cuenta | [Members](#ep-members-list) |
| `PATCH` | `/api/v1/members/:id` | Socio | [Members](#ep-members-patch) |
| `DELETE` | `/api/v1/members/:id` | Socio | [Members](#ep-members-delete) |
| `PATCH` | `/api/v1/members/:id/reactivate` | Socio | [Members](#ep-members-reactivate) |
| `PATCH` | `/api/v1/members/:id/commission-rate` | Socio | [Commissions](#ep-members-commission-rate) |
| `POST` | `/api/v1/devices/identify` | Cuenta | [Devices](#ep-devices-identify) |
| `POST` | `/api/v1/products` | Socio | [Products](#ep-products-create) |
| `GET` | `/api/v1/products` | Cuenta | [Products](#ep-products-list) |
| `GET` | `/api/v1/products/:id` | Cuenta | [Products](#ep-products-get) |
| `PATCH` | `/api/v1/products/:id` | Socio | [Products](#ep-products-patch) |
| `GET` | `/api/v1/products/:id/audit` | Cuenta | [Products](#ep-products-audit) |
| `POST` | `/api/v1/products/:id/image` | Socio | [Products](#ep-products-image) |
| `DELETE` | `/api/v1/products/:id` | Socio | [Products](#ep-products-delete) |
| `PATCH` | `/api/v1/products/:id/reactivate` | Socio | [Products](#ep-products-reactivate) |
| `POST` | `/api/v1/sales` | Member | [Sales](#ep-sales-create) |
| `GET` | `/api/v1/sales` | Socio | [Sales](#ep-sales-list) |
| `GET` | `/api/v1/sales/:id` | Cuenta | [Sales](#ep-sales-get) |
| `GET` | `/api/v1/incidencias` | Socio | [Incidencias](#ep-incidencias-list) |
| `GET` | `/api/v1/incidencias/:id` | Socio | [Incidencias](#ep-incidencias-get) |
| `PATCH` | `/api/v1/incidencias/:id/resolver` | Socio | [Incidencias](#ep-incidencias-resolver) |
| `GET` | `/api/v1/commissions` | Socio | [Commissions](#ep-commissions-get) |
| `PATCH` | `/api/v1/settings/commission-rate` | Socio | [Commissions](#ep-settings-commission-rate) |
| `GET` | `/api/v1/reports/sales-by-period` | Socio | [Reports](#ep-reports-period) |
| `GET` | `/api/v1/reports/sales-by-member` | Socio | [Reports](#ep-reports-member) |
| `POST` | `/api/v1/deudas` | Socio | [Deudas](#ep-deudas-create) |
| `GET` | `/api/v1/deudas` | Socio | [Deudas](#ep-deudas-list) |
| `GET` | `/api/v1/deudas/:id` | Socio | [Deudas](#ep-deudas-get) |
| `POST` | `/api/v1/deudas/:id/abonos` | Member | [Deudas](#ep-deudas-abonos) |
| `POST` | `/api/v1/business-registration` | Registro de negocio | [Business Registration](#ep-br-create) |
| `GET` | `/api/v1/business-registration/approve` | Registro de negocio | [Business Registration](#ep-br-approve) |
| `GET` | `/api/v1/business-registration/reject` | Registro de negocio | [Business Registration](#ep-br-reject) |

Montajes **fuera** del prefijo `/api/v1` (no son rutas de negocio; ver [1.2](#f-montajes)):

| Método | Ruta | Acceso |
|---|---|---|
| `GET` | `/docs`, `/docs-json`, `/docs-yaml` | Solo con `ENABLE_API_DOCS=true` y Basic Auth; si no, 404 |
| `GET` | `/uploads/products/<uuid>.png` | Pública, sin JWT |

<a id="apendice-b-aclaraciones"></a>
## Apéndice B: Aclaraciones y puntos por verificar en vivo

### B.1 Diferencias entre otras fuentes y el código (gana el código)

- **`doc/reglas-de-negocio.md`, línea 141**: dice que un `contextId` enviado en el body "sería ignorado". En el código actual es **400** (`forbidNonWhitelisted: true`).
- **Swagger (`src/docs/bazaar-examples.ts`)** puede estar desactualizado en detalles: los ejemplos de `GET /members` y de Member completo omiten `active`; los ejemplos de producto omiten `active`; el ejemplo de auditoría omite `contextId`; el ejemplo de respuesta de `POST /business-registration` incluye `resolvedAt` y `createdContextId` que el servicio **no devuelve** (solo `id`, `status`, `createdAt`); los ejemplos de `GET /products` y `GET /members` no mencionan `includeInactive`.
- **Swagger, `businessRegistrationApprove`**, y la página HTML de aprobación dicen que el negocio queda "listo para iniciar sesión", pero la aprobación no crea `Account` ni `Device` (ver [Business Registration](#mod-business-registration)).
- **`README.md`**: su tabla de rutas omite `GET /products/:id`, `DELETE /products/:id`, `PATCH /products/:id/reactivate`, `PATCH|DELETE /members/:id`, `PATCH /members/:id/reactivate` y el módulo de business-registration.
- **`bazar-frontend/.env.example`** propone `VITE_API_URL` absoluto (`http://localhost:3000/api/v1`), incompatible con el proxy de Vite y con la ausencia de CORS (ver [1.10](#f-cors)).

### B.2 Verificación contra un servidor en marcha (2026-09-24)

Lo que en el primer borrador quedó "por verificar" se ejecutó contra un servidor real, con un contexto temporal:

| Punto | Resultado |
|---|---|
| Flujo de autenticación y guards | Confirmado: `login` 200; `GET /members` con solo token 200; `POST /devices/identify` con `identifier`+`name` exactos 200 `{ deviceId }`, con otro `name` o un `identifier` nuevo 403; `POST /products` sin headers, con solo member o solo device 403 `Valid member and device selection required`; colaborador 403 `Only socios may access this resource`; `GET /products` funciona con solo token |
| `Authorization` | `Bearer` en minúsculas se acepta; sin el esquema `Bearer` 401. Un header de selección repetido da 403 `Valid member and device selection required` |
| Paginación | Confirmado: `limit=101`, `limit=0`, `page=0`, `page=1000001`, `limit=abc` dan 400 con mensajes de validación; los valores por defecto son `page: 1`, `limit: 20` |
| Venta con conflicto | **Reproducido en vivo** con dos ventas simultáneas de la última unidad: una respondió `201` `completada` y la otra `201` `rechazada_por_conflicto` con `totalMinor: null`, `changeMinor: null`, `items: []` y `conflictReason: "stock insuficiente al sincronizar: producto <id>, solicitado 1, disponible 0"`; se creó la incidencia `conflicto_stock` |
| Idempotencia y errores de venta | Confirmado: reenvío del mismo `id` y payload 200; mismo `id` con otro payload 409 `Sale <id> already exists with different data`; producto inexistente, stock insuficiente, `unica` con cantidad 2, efectivo insuficiente y producto desactivado 400 con los mensajes documentados; `memberId` del body distinto del header 403 `Sale attribution must match the authenticated selection`; el precio cobrado es el del catálogo, no el enviado |
| `occurredAt` | Fecha simple aceptada (`2026-09-23` se guarda a medianoche UTC). Un `occurredAt` 5 minutos en el futuro guarda la venta como `completada` y crea una incidencia `incidencia_fecha` (`occurredAt es 0.1h posterior a receivedAt (fecha futura)`), que no aparece en la respuesta de la venta; uno 5 días atrás también la crea |
| Borrado lógico | Confirmado: `DELETE` de producto y de member responde 200 con cuerpo y es idempotente; el listado por defecto los oculta; `includeInactive=true` solo se respeta con el `x-member-id` de un socio activo (con colaborador o solo token se ignora); un Member desactivado recibe 403 `Selection is not authorized for this context`; desactivar y reactivar un producto **no** escribe auditoría (1 sola fila, la de la creación) |
| Imágenes | Confirmado: subida 201 con `image: "/uploads/products/<uuid>.png"` (sin `imagePath`); el archivo se sirve con `Content-Type: image/png`, `X-Content-Type-Options: nosniff` y `Content-Security-Policy: default-src 'none'; sandbox`; `/api/v1/uploads/...` 404. Errores: `Image is required`, `Unsupported image signature` (SVG), `Unexpected file field - foto`, `Too many fields`, `Too many files`, 413 `File too large`; colaborador 403 |
| Comisiones y reportes | Confirmado: semana por defecto domingo–sábado en UTC-6 (`2026-09-20T06:00:00.000Z` a `2026-09-27T05:59:59.999Z`); un solo extremo 400 con el mensaje documentado; `memberId` de un socio 404; `from` > `to` 200 en ceros; semana u ordinal ISO 400 `Invalid date: ...`; los totales de `sales-by-period` coinciden con las ventas hechas |
| Deudas | Confirmado: creación con `deudor` en línea 201 sin `deudor` anidado; ambos o ninguno de `deudorId`/`deudor` 400 `Exactly one of deudorId or deudor must be provided`; campo desconocido anidado `deudor.property foo should not exist`; colaborador no crea (403) pero **sí** registra abonos; un abono mayor al saldo 400 `Abono of <monto> exceeds the remaining balance of <saldo>`; un abono a una deuda saldada 400 con saldo 0 |
| Business registration | Confirmado solo lo que no envía correo: validación 400 (vacío, campo desconocido, cadenas en blanco), y las páginas HTML `Enlace inválido` con `404` y `Content-Type: text/html` para `approve`/`reject` sin `token` o con un token desconocido. El `201` con correo real se verificó en otra sesión (`Approval email accepted by Resend`); no se repitió para no enviar otro correo |
| Formatos de error | Ver [1.8](#f-errores): 404 JSON bajo `/api/v1` y HTML fuera del prefijo; 413 para body JSON de más de ~100 kb; 400 con `message` string para un body que no es JSON |

Sin verificar aquí: que Axios con `FormData` mande el `boundary` correcto cuando la instancia fuerza `Content-Type: application/json` (depende del cliente del frontend, no del backend), y la forma exacta del 500 cuando el correo falla.

### B.3 Otras notas para quien integra

- Un `GET` con parámetro de query no declarado es 400 (p. ej. `GET /members?foo=1`). Las rutas de `business-registration/approve|reject` son la excepción: leen `token` sin `ValidationPipe`.
- Cabeceras HTTP no distinguen mayúsculas (`x-member-id` = `X-Member-Id`), pero cada una debe aparecer **una sola vez**.
- `image` de producto y el resto de campos crudos: ver [1.11](#f-crudos).
- No hay endpoints para: crear Members, crear/listar dispositivos, crear cuentas, cerrar sesión, refrescar token, editar/cancelar ventas o deudas, consultar el estado de un registro de negocio.

### B.4 Problemas conocidos del backend (verificados, no corregidos)

Esto no cambia el contrato de arriba, pero conviene saberlo al construir el frontend:

- **Un negocio aprobado no puede iniciar sesión.** La aprobación crea solo el Member socio fundador; no hay endpoint ni código que cree su `Account` ni un `Device`. La página de aprobación dice "listo para iniciar sesión", pero hace falta crear cuenta y dispositivo fuera de banda. Tampoco hay `GET` para consultar el estado de una solicitud.
- **HTML sin escapar en las páginas de aprobar/rechazar.** `renderStatusPage` (`src/business-registration/status-page.html.ts`) inserta `nombreNegocio`, un campo de un formulario público, sin escapar; el correo sí lo escapa. Es un XSS almacenado que se ejecuta en el navegador de quien abre el enlace.
- **Sin límite de tasa** en `POST /business-registration`: cada llamada válida crea una solicitud y dispara un correo. Si el correo falla responde 500, pero la solicitud ya quedó `pendiente`.
- **Datos internos en las respuestas:** las ventas incluyen `requestFingerprint` (verificado en vivo) y los snapshots de auditoría de producto incluyen `imagePath`, la clave interna de almacenamiento (verificado en vivo).
- **Reemplazar una imagen no borra la anterior** del disco; sigue accesible por su URL vieja.
- **Imágenes en desarrollo:** el proxy de Vite solo cubre `/api`, así que `/uploads/products/...` no llega al backend hasta añadir un proxy para `/uploads`.
- **El cliente Axios actual** (`bazar-frontend/src/services/api.ts`) solo envía `Authorization`; faltan `x-member-id` y `x-device-id`. Además menciona `/auth/register`, que no existe.
- **`GET /sales/:id`** solo pide token: cualquier cuenta del negocio lee cualquier venta de su propio negocio si conoce el `id`.
- **El 401 no distingue** token expirado, cuenta desactivada o token inválido; no hay refresh ni logout.
