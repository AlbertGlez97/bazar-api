# Reglas de negocio consolidadas (hasta BE-11)

> A partir de BE-11 el sistema es multi-tenant: opera múltiples negocios
> independientes (cada uno, un `contextId`) sobre la misma base de datos,
> con aislamiento total entre ellos (ver la sección "Multi-tenancy
> (BE-11)" para el mecanismo). Salvo que se indique lo contrario, TODA
> regla de las secciones siguientes (Productos, Ventas, Socios y
> colaboradores, Comisiones, Reportes, Fiado y apartados, etc.) describe
> el comportamiento **dentro de un mismo contexto/negocio** — "el
> catálogo", "los socios", "las ventas" siempre se refieren al catálogo/
> socios/ventas de un negocio en particular, nunca a un catálogo o roster
> global compartido entre negocios distintos. Ningún dato de un contexto
> es visible, editable ni contable desde otro.

## Productos
- Un producto es "unica" o "cantidad". Única inicia con existencia 1; al venderse pasa a 0 (nunca se marca "vendida", el estado vendido se infiere de existencia=0). El frontend muestra en gris y deshabilita productos con existencia 0.
- Campos obligatorios: nombre, tipo, precio de venta, existencia inicial. Opcionales: imagen, categoría, costo de compra, proveedor, notas.
- Solo Member con role="socio" puede crear/editar productos. Los "colaborador" solo consultan.
- Toda edición de producto queda registrada en un historial de auditoría (quién, cuándo, valores anterior/nuevo), especialmente para cambios de precio.
- Las imágenes se suben como archivo real (no URL de texto) y se guardan en disco local del servidor por ahora; se diseñó detrás de una interfaz de storage para poder migrar a object storage (ej. MinIO) sin tocar el módulo de productos.
- El listado de productos está paginado desde BE-04.

## Dinero
- Moneda única: MXN. Todos los montos se almacenan como enteros en centavos (sufijo *Minor en los nombres de campo).
- Las operaciones aritméticas sobre dinero usan la librería dinero.js, nunca Number ni Decimal directamente.
- Los DTO que reciben montos validan que sean enteros (@IsInt()) para rechazar decimales mal formados en la entrada.

## Identificadores
- Todo identificador creado por los servicios del backend usa UUIDv7 mediante la librería oficial `uuid`. El orden temporal incorporado en UUIDv7 reduce la dispersión de inserciones en índices de tablas que crecen continuamente, como `SaleItem` e `Incidencia`, sin renunciar a identificadores globalmente únicos.
- Los identificadores fijos y legibles del seed son una excepción intencional para datos de arranque reconocibles y reejecutables; no representan el mecanismo de generación usado en producción y no deben reemplazarse por valores aleatorios.
- `Sale.id` pertenece al cliente porque la tablet debe generarlo aun sin conexión y reutilizarlo como clave de idempotencia. El backend no lo reemplaza; se recomienda que el frontend genere UUIDv7 para conservar la misma localidad temporal en el índice.
- Los `@default(uuid())` existentes en Prisma se conservan como respaldo para fixtures y operaciones administrativas directas. Los flujos HTTP de producción asignan explícitamente UUIDv7 antes de cada creación para mantener la política visible en los servicios y evitar una función específica de PostgreSQL.

## Preparación offline
- Antes de operar sin conexión, cada dispositivo debe haber iniciado sesión al menos una vez con internet, tener el catálogo descargado (nombre, precio, existencia) y su propio nombre de dispositivo registrado.
- Las ventas hechas offline se guardan localmente y se sincronizan al reconectar.

## Identificación de vendedor y dispositivos
- La tablet/teléfono es compartida entre socios. Se elige rápidamente qué socio/colaborador está atendiendo mediante un selector de persona, sin PIN.
- Los dispositivos deben estar autorizados previamente (vía seed) para poder operar.
- El ContextGuard exige que cuenta, miembro y dispositivo pertenezcan al mismo contexto autorizado.

## Socios y colaboradores
- Member tiene role: "socio" | "colaborador", y pertenece a un `contextId` específico (no es global/único en el sistema — desde BE-11 cada negocio tiene su propio conjunto independiente de socios y colaboradores). Los socios de un contexto tienen privilegios administrativos completos sobre ese contexto (incluye alta de productos). Los colaboradores (futuro: familiares que ayuden a vender) solo pueden registrar ventas y consultar catálogo, también dentro de su propio contexto.
- Cualquier socio o colaborador autenticado puede registrar una venta.
- Descuentos y cancelaciones están bloqueados hasta que se defina una política aparte (no implementados en E0).
- Alberto y Adid, mencionados en el resto de este documento como ejemplo recurrente de "los socios", son únicamente los dos socios fundadores del contexto fijo que crea `prisma/seed.ts` (`SEED_CONTEXT_ID`) para desarrollo/pruebas — un ejemplo concreto de un contexto entre potencialmente muchos, no una limitación de que el sistema solo admita dos socios o un solo negocio. Cada negocio nuevo registrado vía BE-11 tiene su propio socio fundador con su propio nombre (ver "Registro de negocio (BE-11)").

## Ventas (BE-05)
- Venta presencial al contado en el bazar, no e-commerce.
- El servidor SIEMPRE calcula el total con el precio actual de Product en base de datos; el unitPriceMinor que manda el cliente en el request se ignora para el cálculo.
- Si cashReceivedMinor es menor al total, se rechaza la venta completa (400). No hay fiado en este flujo de venta al contado; ver sección "Fiado y apartados (Deuda)" para el concepto de crédito/apartado, implementado por separado en BE-09.
- Si algún item no tiene stock suficiente, se rechaza LA VENTA COMPLETA (atómica, todo o nada), no una venta parcial.
- Toda la venta ocurre dentro de una única transacción: cálculo, validación de stock, descuento de existencia y persistencia. Un fallo revierte todo.
- El memberId y deviceId del body deben coincidir con el contexto autenticado (ContextGuard); si no coinciden, se rechaza con 403.
- Descuento de existencia: única pasa de 1 a 0; cantidad resta las unidades vendidas.

## Explícitamente fuera de alcance de E0 (pendiente para entregas futuras)
- Resolución automática de conflictos de sincronización offline (reembolso, reasignación de stock a la venta perdedora): permanece una decisión humana fuera del sistema (ver BE-06).
- Migración de almacenamiento de imágenes de disco local a object storage (MinIO en home-lab). No implementado.
- Pago efectivo de comisiones (marcar una comisión como "pagada", integración con algún medio de pago): BE-08 solo calcula el monto; el pago en sí sigue siendo manual y fuera del sistema.

## Metodología de desarrollo
- TDD desactivado en BE-02 a BE-04 (infraestructura, auth, productos). Activo desde BE-05 (venta, cálculos, idempotencia).

## Documentación de API
- La documentación OpenAPI/Swagger vive en /docs, protegida con HTTP Basic Auth (credenciales independientes del sistema de auth de socios/colaboradores, vía DOCS_USER/DOCS_PASSWORD).
- Solo se registra si ENABLE_API_DOCS=true está presente en el entorno; si no, la ruta no existe (404, no 401), para no revelar su existencia.
- No usar el mismo mecanismo de credenciales que la API de negocio; son capas de acceso distintas.

## Idempotencia y conflictos offline (BE-06, extendido en BE-07)
- Reenviar una venta con el mismo id y el mismo payload devuelve el resultado ya persistido con 200 OK (no 201, que queda reservado para la creación real de una venta nueva), sin duplicar ni volver a descontar stock. Si el payload difiere, se rechaza con 409.
- Dos requests con el mismo id nuevo en carrera real (ambos pasan la verificación previa como "no existe") pueden chocar en la escritura misma: el segundo intento captura específicamente el error P2002 (violación de unicidad) del id de Sale, relee la venta ya persistida por el primero y aplica la misma regla de idempotencia (200 si el payload coincide, 409 si no) — nunca revienta como error 500 genérico.
- Ante conflicto de stock entre ventas offline sincronizadas sobre el mismo producto, gana la que el servidor procesa primero (orden real de procesamiento, no hora del dispositivo).
- Las ventas que pierden el conflicto no se pierden ni se descartan: quedan guardadas con status="rechazada_por_conflicto" y motivo, sin afectar inventario, disponibles para revisión y resolución manual con el cliente. Desde BE-07 este conflicto también genera un registro en la tabla Incidencia (ver sección siguiente); Sale.status se conserva además de Incidencia porque sirve como filtro barato/rápido ("¿esta venta afectó inventario?"), mientras que Incidencia sostiene el flujo de seguimiento y resolución.
- No hay resolución automática de conflictos (reembolso, reasignación de stock); es una decisión humana fuera del sistema.

## Incidencias
- Las incidencias (conflicto de stock, fecha fuera de rango) se registran en una tabla propia (Incidencia), no solo como un estado de Sale, para permitir consulta, filtrado, paginación y seguimiento de resolución independiente del ciclo de vida de la venta.
- Toda incidencia queda en estado "pendiente" hasta que un socio la marca como "resuelta" con notas de qué se acordó con el cliente. No hay resolución automática.
- Solo socios pueden ver y resolver incidencias; colaboradores no tienen acceso.
- occurredAt fuera de rango (futuro, o más de 2 días en el pasado respecto a receivedAt) genera una incidencia tipo "incidencia_fecha" sin bloquear la venta si es válida en lo demás.
- JWT de dispositivos: expiresIn extendido a 12h para cubrir una jornada de bazar sin requerir refresh token, dado que los dispositivos ya están pre-autorizados por seed.

## Comisiones (BE-08)
- La comisión de un colaborador es un porcentaje del total que vendió en el periodo (no un monto fijo por venta), para que el pago escale con lo que realmente ayudó a vender, no de forma pareja entre un turno flojo y uno fuerte.
- Existe un porcentaje global por defecto (AppSettings, una fila por contexto); cada colaborador puede tener uno individual (Member.commissionRateBps) que lo sobrescribe cuando no es null. Solo socios los configuran (PATCH /settings/commission-rate y PATCH /members/:id/commission-rate).
- Ambos porcentajes se almacenan como enteros en puntos base (1000 = 10.00%), siguiendo la misma convención de enteros que el dinero, para evitar imprecisión de punto flotante.
- El corte de periodo es semanal, domingo a sábado, usando receivedAt (fecha del servidor) como referencia, no occurredAt. La zona horaria asumida es America/Mexico_City, fija en UTC-6 todo el año (la reforma de 2022 eliminó el horario de verano en la mayor parte del país), documentada explícitamente en src/common/business-time.ts ya que el proyecto no tenía una convención de zona horaria previa a esta entrega.
- Si no se pasan fechas explícitas a GET /commissions, se resuelve automáticamente la semana domingo-sábado actual.
- El cálculo solo considera ventas con status="completada"; ventas con una Incidencia pendiente de resolver igual se incluyen en el cálculo (la incidencia se resuelve por separado; si su resolución cambia el resultado de una venta, el recálculo es manual, el sistema no oculta ventas del cálculo solo por tener una incidencia pendiente).
- La multiplicación por el porcentaje se hace con dinero.js (factor racional exacto vía scale, redondeo half-up al convertir de vuelta a centavos), nunca con Number/Decimal.
- Esta entrega solo calcula el monto de comisión; no implementa pago ni lo marca como pagado (ver sección "fuera de alcance").

## Reportes (BE-08)
- Dos reportes disponibles: GET /reports/sales-by-period (total vendido y número de ventas en un rango), y GET /reports/sales-by-member (desglose del total vendido por cada Member, socio o colaborador), ambos filtrables por rango de fechas (from/to, aceptando fecha simple o instante ISO-8601 completo) y restringidos a socios.
- Solo cuentan ventas con status="completada".
- Un valor from/to de solo fecha (sin hora) se interpreta como el día completo en la zona horaria de negocio (inicio de ese día para from, fin de ese día para to), para que un socio pueda pedir "las ventas del 5 de mayo" sin tener que calcular instantes UTC a mano.

## Fiado y apartados (Deuda)
- Un solo concepto "Deuda" con dos tipos: "fiado" (producto ya entregado) y "apartado" (producto reservado). Ambos descuentan inventario de inmediato al crearse, para evitar que el producto se venda dos veces mientras el cliente abona.
- Solo socios pueden autorizar una Deuda (crear un fiado/apartado). Cualquier Member (socio o colaborador) puede registrar abonos.
- El total se calcula con el precio actual del producto, igual que en ventas — el servidor no confía en el precio que mande el cliente.
- Un abono no puede exceder el saldo pendiente. El estado "saldada" se deriva automáticamente cuando los abonos cubren el total; no se marca manualmente.
- El deudor se registra con nombre, teléfono opcional y notas opcionales — sin validación de identidad formal.
- Deuda es deliberadamente de un solo producto/cantidad (no una lista de items como Sale/SaleItem): la especificación de BE-09 define campos escalares (productId, cantidad), y en la práctica un fiado/apartado informal se negocia por pieza con el cliente, no como un carrito de compras. Un cliente que quiere crédito sobre varios productos distintos se representa hoy como varias filas de Deuda; graduar a un modelo multi-item (espejo de SaleItem) queda pendiente si esta suposición resulta incorrecta en la práctica.
- POST /deudas acepta un deudorId existente o un objeto deudor inline (nombre/telefono/notas) para crear uno nuevo en la misma transacción; exactamente uno de los dos debe enviarse.
- No hay reconciliación de conflictos de sincronización offline para Deuda (a diferencia de Sale/BE-06): una Deuda siempre se crea en persona, en línea, por un socio, así que stock insuficiente es siempre un rechazo simple (400), nunca un registro de conflicto persistido.

## Eliminación de productos y colaboradores (soft delete)
- Ni productos ni colaboradores se borran físicamente de la base de datos. Se desactivan mediante un campo active, preservando todo el historial relacionado (ventas, auditoría, comisiones, incidencias, deudas).
- Un producto desactivado no aparece en el catálogo de venta ni puede venderse, pero su historial permanece intacto y consultable.
- Un colaborador desactivado no puede iniciar sesión ni ser seleccionado como vendedor, pero su historial de ventas y comisiones pasadas permanece intacto.
- Los socios (ver nota sobre Alberto/Adid en "Socios y colaboradores": aquí "los socios" son los del contexto de cada Member evaluado, no una lista fija) no pueden desactivarse mediante este mecanismo.
- Ambas entidades pueden reactivarse.
- Detalle de implementación: este sistema no tiene login por Member (solo por Account, compartido entre socio y colaboradores del mismo dispositivo); "un colaborador desactivado no puede iniciar sesión" se aplica en la práctica como "no puede ser seleccionado como el actor de la sesión" en ContextGuard, que es el único punto donde un Member se resuelve por request — un Member con active=false deja de resolver ahí, bloqueando cualquier venta, deuda o mutación de catálogo atribuida a esa persona.
- DELETE /products/:id y DELETE /members/:id son idempotentes: desactivar un registro ya inactivo devuelve 200 con el estado actual, no un error 409 — no hay una preocupación de proveniencia de datos como en resolver una incidencia dos veces, así que tratarlo como error solo complicaría la lógica de reintento del frontend sin ganar seguridad.
- GET /products y GET /members aceptan ?includeInactive=true para que un socio revise el catálogo/roster completo (incluyendo desactivados). Se restringe a socios mediante una verificación ligera (opcional header x-member-id resuelto contra un Member activo con role="socio" en el mismo contexto), sin exigir la selección completa de member/device (ContextGuard/SocioGuard) que estos endpoints de lectura no tienen — ambos se usan también antes de que exista una selección (ej. para poblar el selector de persona). Si quien pide includeInactive=true no resuelve a un socio (colaborador, header ausente o inválido), el parámetro se ignora silenciosamente y se devuelve solo lo activo; no se rechaza con 403, ya que la causa más probable es un parámetro accidental del frontend, no un intento malicioso, y el riesgo de exponer nombres de productos/colaboradores desactivados es bajo incluso en ese caso.

---

Este documento se actualiza conforme se cierran nuevas decisiones de negocio en cada entrega. Última actualización: BE-11.

## Multi-tenancy (BE-11)
- El sistema opera múltiples negocios independientes sobre una sola base de datos compartida, aislados por contextId en cada tabla relevante.
- Doble capa de aislamiento: Prisma Client Extension (aplicación) + Postgres Row-Level Security (base de datos), para que una fuga en una capa sea detenida por la otra.
- Un nuevo negocio se registra vía formulario público, pero requiere aprobación manual por correo (Resend) antes de quedar operativo. El link de aprobación/rechazo es de un solo uso, con 30 días de expiración.
- Mientras una solicitud está pendiente o fue rechazada, no existe ningún contextId ni Member operativo asociado a ella.
- Detalle de implementación — dónde se establece el contextId activo: `AuthGuard` (no `ContextGuard`), inmediatamente después de resolver el `Account`, ya que varios endpoints de solo lectura (`GET /products`, `GET /members`, `POST /devices/identify`) usan únicamente `AuthGuard` pero igual tocan modelos con contextId. `TenantContextMiddleware` abre el AsyncLocalStorage vacío para *toda* ruta (incluidas las públicas de registro de negocio) antes de que corra cualquier guard, para que `AuthGuard` tenga dónde escribir.
- Detalle de implementación — "sin scope de request" se trata como acceso administrativo de confianza a nivel de aplicación (passthrough, sin contextId forzado por la extensión): esto es intencional para que `prisma/seed.ts` y las pruebas e2e (que llaman `prisma.member.create(...)` directamente, fuera de cualquier request HTTP) puedan seguir pasando el contextId ellas mismas sin que la extensión lo sobreescriba. Con RLS ahora estricta (ver el siguiente punto), esa confianza de la capa de aplicación ya no es suficiente por sí sola: seed y pruebas también deben fijar `app.context_id` explícitamente en Postgres (vía `set_config`/`withTestTenant`), o la base de datos rechaza la operación sin importar lo que diga la capa de aplicación.
- Detalle de implementación — RLS estricta, deniega por defecto (sin excepción): las políticas usan `"contextId" = current_setting('app.context_id', true)`, sin ninguna cláusula `OR` de permisividad — una conexión que nunca fija esa variable de sesión no ve ni puede escribir ninguna fila de ninguna tabla con contextId, punto. Esto aplica sin excepción: producción, `prisma/seed.ts` y cada prueba e2e deben fijar `app.context_id` explícitamente antes de tocar una tabla con contextId (ver `test/tenant-scope.ts`, el helper `withTestTenant` que las pruebas usan para esto), exactamente como lo haría una request real autenticada. La doble capa de aislamiento pierde su propósito si una de las dos capas se degrada silenciosamente a "permitir todo" cuando falla — por eso se descartó la versión anterior (permisiva mientras no hubiera contexto fijado). Esta garantía solo existe para un rol de conexión sin `SUPERUSER` ni `BYPASSRLS`: Postgres nunca aplica RLS a esos roles, ni siquiera con `FORCE ROW LEVEL SECURITY`, y el `POSTGRES_USER` del contenedor de Docker es superusuario (verificado el 2026-09-24: conectado como superusuario, las 11 tablas devolvían todas sus filas sin contexto). Por eso la aplicación, `prisma db seed` y las pruebas se conectan con un rol de runtime dedicado (`APP_DB_USER`, sin `SUPERUSER` ni `BYPASSRLS`), el dueño se usa solo para migraciones (`DATABASE_URL_MIGRATE`), y la aplicación se niega a arrancar con una conexión superusuario o `BYPASSRLS`. Preparación y verificación: `doc/runtime-database-role.md`.
- Detalle de implementación — aprobación de un negocio nuevo: `approve` (endpoint público, sin request scope) fija `app.context_id` (local a la transacción) al `contextId` recién creado antes de crear el Member fundador; sin eso Postgres rechaza el INSERT con SQLSTATE `42501` para cualquier rol al que RLS aplique. No se veía mientras la aplicación se conectaba como superusuario.
- Detalle de implementación — conflicto de ids fijos del seed entre contextos: cuando el `id` fijo de un Member (o el `identifier` de un Device) ya pertenece a otro contexto, RLS oculta esa fila y Postgres responde con una violación de unicidad (`P2002` / SQLSTATE `23505`, `Member_pkey` o `Device_identifier_key`), no con una violación de RLS. La violación de RLS (`42501`, mensaje `new row violates row-level security policy`, que Prisma 7 con adapter-pg reporta como `P2039` con el código en `meta.driverAdapterError.cause`) ocurre al escribir con un `contextId` ajeno o sin `app.context_id`. `seedContext` reconoce ambos casos y lanza `Seed member context mismatch` / `Seed device context mismatch`.
- Detalle de implementación — transacciones de la extensión: el override de `$transaction` toma el `$transaction` del cliente base y lo invoca con el cliente extendido como receptor (llamar al método del propio cliente extendido recurre sin fin), y la marca "dentro de una transacción gestionada" vive en su propio `AsyncLocalStorage`: un campo mutable restaurado antes de que corrieran las consultas asíncronas hacía que cada llamada anidada abriera su propia transacción.
- Detalle de implementación — escrituras anidadas fuera del alcance de la extensión: Prisma Client Extensions solo interceptan la operación de nivel superior; los `create` anidados de un modelo distinto dentro de ella (SaleItem/Incidencia dentro de `Sale.create`) no son vistos por la extensión, así que su contextId se fija a mano en `sales.service.ts`. `ProductAudit` (en `products.service.ts`), `Deuda` y `Abono` (en `deudas.service.ts`) ya se crean con `create` de nivel superior (cubiertos automáticamente por la extensión una vez cableada), pero también llevan contextId explícito por consistencia con el estilo ya establecido en el proyecto.
- Detalle de implementación — el `$queryRaw` con lock `FOR UPDATE` sobre `Deuda`: en `deudas.service.ts` (dentro de `registerAbono`) ahora filtra explícitamente por `contextId` además de `id` (`AND "contextId" = ${actor.account.contextId}`), ya que $queryRaw es el único punto del código que la Prisma Client Extension no puede ver ni interceptar (no hay gancho de extensión para consultas crudas). Se mantiene como raw en vez de reescribirse con el Prisma Client normal porque Prisma no expone una API de query builder para `SELECT ... FOR UPDATE` (bloqueo de fila); un `findFirst` normal no serializaría dos abonos concurrentes contra la misma Deuda.
- Detalle de implementación — bootstrap de negocio nuevo: el endpoint público de aprobación de registro (`GET /business-registration/approve`) corre bajo el middleware (hay scope) pero ningún guard puebla un contextId (es una ruta pública, sin Account todavía) — se le permite crear el Member fundador y demás filas iniciales pasando el contextId recién generado explícitamente en el propio `create`, que la extensión acepta como fuente de verdad cuando no hay un contextId ya activo en el AsyncLocalStorage.
- Detalle de implementación — `contextId` nunca es un campo de entrada: ningún DTO de creación/edición (`CreateProductDto`, `CreateSaleDto`, `CreateDeudaDto`, `PatchMemberDto`, etc.) acepta `contextId` en el body — siempre se infiere del contexto autenticado (`AuthGuard`/`ContextGuard` + la extensión), nunca del cliente; un cliente que lo incluyera en el body sería ignorado (la extensión sobreescribe/rellena ese campo con el valor autoritativo). Sí aparece, en cambio, en las respuestas JSON de los modelos que lo tienen (Product, Member, Sale, Incidencia, Deuda, Abono, etc.), porque estos endpoints devuelven el registro de Prisma tal cual, sin una capa de DTO de respuesta que filtre campos — igual que ya pasaba con cualquier otro campo interno antes de BE-11. No se consideró necesario ocultarlo: no es secreto (es solo el identificador del propio negocio del cliente autenticado, nunca el de otro), y el frontend de un solo negocio simplemente lo ignora.

## Registro de negocio (BE-11)
- Formulario público POST /business-registration: nombre del negocio, nombre y contacto del socio fundador. Crea una SolicitudNegocio en estado "pendiente" — no se crea ningún contextId ni Member todavía.
- Se envía un correo (vía Resend, remitente de pruebas onboarding@resend.dev) al destinatario fijo configurado en APPROVAL_NOTIFICATION_EMAIL, con los datos de la solicitud y dos links: aprobar y rechazar.
- El token de cada link es de un solo uso y expira en 30 días; se guarda hasheado (nunca en texto plano), igual que se hace con contraseñas — así una fuga de la base de datos no permite aprobar/rechazar negocios ajenos usando el valor guardado directamente.
- Al aprobar: se crea el contextId real y el Member fundador (role="socio"), y la solicitud pasa a "aprobado". Al rechazar: la solicitud pasa a "rechazado" y no se crea nada operativo.
- Un token ya usado o expirado no produce un error crudo de API: ambos endpoints (approve/reject) devuelven una página HTML simple de estado ("ya fue procesado" / "el enlace expiró"), ya que quien sigue el link lo abre desde un cliente de correo, no desde un cliente de API.

## Notas de verificación de la implementación
- Las ventas nuevas conservan una huella del request normalizado, incluidos los productos y cantidades intentados en una venta rechazada por conflicto. Cambiar esos datos al reenviar el mismo identificador devuelve 409; el precio enviado por el cliente no forma parte de la identidad porque no es autoritativo.
- Las ventas históricas rechazadas sin huella ni partidas no permiten reconstruir el request original. Sus reenvíos devuelven 409 de forma conservadora; no se inventa ni elimina historial.
- La detección de conflicto de stock actual cubre la carrera entre transacciones. Una solicitud secuencial que llega cuando ya no hay stock devuelve 400, sin crear una incidencia; no equivale a una reconciliación completa de todas las colas offline.
- La documentación JSON/YAML también requiere las credenciales independientes de documentación cuando está habilitada, no solo la interfaz `/docs`.
- Verificación de BE-11 (2026-09-24, primera ejecución real): compila, el lint no reporta errores, las 13 migraciones aplican desde cero y sobre la base de desarrollo existente (con backfill por relación), `prisma db seed` es idempotente bajo RLS real, y las pruebas unitarias (9 archivos / 72 pruebas) y e2e (18 archivos / 124 pruebas) pasan con el rol de runtime sin privilegios, incluida la prueba de RLS estricta. Verificado con SQL directo como ese rol: 0 filas en las 11 tablas sin `app.context_id`, solo las del contexto fijado con él, y sin permiso para DDL ni sobre `_prisma_migrations`. Pendiente: verificar de extremo a extremo el registro de negocio con correo real (Resend), que requiere `RESEND_API_KEY`.
